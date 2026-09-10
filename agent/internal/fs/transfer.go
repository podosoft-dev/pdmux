package fs

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

const transferStateDir = ".pdmux-file-transfers"
const transferEntryLimit = 10_000
const transferByteLimit = 10 * 1024 * 1024 * 1024
const transferTTL = 24 * time.Hour

var transferMu sync.Mutex
var transferUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type transferJournal struct {
	Version    int      `json:"version"`
	TransferID string   `json:"transferId"`
	EntryID    string   `json:"entryId"`
	Path       string   `json:"path"`
	Size       int      `json:"size"`
	Offset     int      `json:"offset"`
	Hashes     []string `json:"hashes"`
	Committing bool     `json:"committing"`
	Committed  bool     `json:"committed"`
	Updated    int64    `json:"updated"`
}

// Transfer acknowledges durable bytes only. A journal and sibling staging file
// survive reconnects; publishing never truncates the destination in place.
func Transfer(root *os.Root, req protocol.FsTransferRequest) protocol.FsTransferResult {
	transferMu.Lock()
	defer transferMu.Unlock()
	result := protocol.NewFsTransferResult()
	result.RequestID, result.TransferID, result.EntryID = req.RequestID, req.TransferID, req.EntryID
	err := transferOperation(root, req, &result)
	if err != nil {
		code := "FILES_TRANSFER_IO"
		var failure *transferError
		if errors.As(err, &failure) {
			code = failure.code
		}
		result.Error = &code
	}
	return result
}

type transferError struct{ code string }

func (e *transferError) Error() string { return e.code }
func transferFail(code string) error   { return &transferError{code: code} }

// Reject ambiguous spellings, including Windows separators, on every platform.
func transferPath(name string, allowRoot bool) (string, error) {
	if name == "" && allowRoot {
		return ".", nil
	}
	if name == "" || len(name) > 1024 || strings.ContainsAny(name, "\\\x00:") || path.IsAbs(name) {
		return "", transferFail("FILES_TRANSFER_PATH")
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || part == transferStateDir || strings.HasPrefix(part, ".pdmux-transfer-") {
			return "", transferFail("FILES_TRANSFER_PATH")
		}
	}
	return name, nil
}

func transferNoLinks(root *os.Root, name string, allowMissing bool) error {
	if name == "." {
		return nil
	}
	parts := strings.Split(name, "/")
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if errors.Is(err, os.ErrNotExist) && allowMissing {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return transferFail("FILES_TRANSFER_LINK")
		}
		if i < len(parts)-1 && !info.IsDir() {
			return transferFail("FILES_TRANSFER_TYPE_CONFLICT")
		}
	}
	return nil
}

func transferOperation(root *os.Root, req protocol.FsTransferRequest, out *protocol.FsTransferResult) error {
	if !transferUUID.MatchString(req.TransferID) || !transferUUID.MatchString(req.EntryID) ||
		req.Offset < 0 || req.Size < 0 || req.Size > transferByteLimit {
		return transferFail("FILES_TRANSFER_INVALID")
	}
	name, err := transferPath(req.Path, req.Action == "list")
	if err != nil {
		return err
	}
	if req.Action == "list" {
		before, err := transferStat(root, name)
		if err != nil {
			return err
		}
		if req.Modified != "" && before.Modified != req.Modified {
			return transferFail("FILES_TRANSFER_SOURCE_CHANGED")
		}
		if err := transferList(root, name, req.Offset, out); err != nil {
			return err
		}
		after, err := transferStat(root, name)
		if err != nil {
			return err
		}
		if after.Modified != before.Modified {
			return transferFail("FILES_TRANSFER_SOURCE_CHANGED")
		}
		return nil
	}
	if req.Action == "read" {
		return transferRead(root, name, req, out)
	}
	checked := name
	if req.Action == "stat" {
		checked = path.Dir(name)
	}
	if err := transferNoLinks(root, checked, true); err != nil {
		return err
	}
	if req.Action == "mkdir" {
		info, err := transferStat(root, name)
		if err != nil {
			return err
		}
		if info.Kind != "missing" && info.Kind != "directory" {
			return transferFail("FILES_TRANSFER_TYPE_CONFLICT")
		}
		if err := root.MkdirAll(name, 0o700); err != nil {
			return err
		}
		out.Committed = true
		return nil
	}
	if req.Action == "stat" {
		entry, err := transferStat(root, name)
		if err != nil {
			return err
		}
		out.Entries = append(out.Entries, entry)
	}
	if err := ensureTransferState(root); err != nil {
		return err
	}
	journal, err := loadTransferJournal(root, req.TransferID, req.EntryID)
	if errors.Is(err, os.ErrNotExist) {
		if req.Action == "stat" || req.Action == "discard" || req.Action == "touch" {
			return nil
		}
		if req.Action != "write" || req.Offset != 0 {
			return transferFail("FILES_TRANSFER_OFFSET")
		}
		journal = transferJournal{
			Version: 1, TransferID: req.TransferID, EntryID: req.EntryID,
			Path: name, Size: req.Size, Hashes: []string{},
		}
		// Save the ownership record before creating the temporary file.
		if err := saveTransferJournal(root, &journal); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if journal.Path != name || journal.Size != req.Size {
		return transferFail("FILES_TRANSFER_SOURCE_CHANGED")
	}
	if journal.Committing && !journal.Committed {
		staged, stageErr := root.Lstat(journal.temp())
		published, publishErr := root.Lstat(journal.Path)
		linked := stageErr == nil && publishErr == nil && staged.Mode().IsRegular() && os.SameFile(staged, published)
		if errors.Is(stageErr, os.ErrNotExist) || linked {
			hashes, err := transferHashes(root, journal.Path, journal.Size)
			if err != nil || transferDigest(strings.Join(hashes, "")) != transferDigest(strings.Join(journal.Hashes, "")) {
				return transferFail("FILES_TRANSFER_SOURCE_CHANGED")
			}
			journal.Committed = true
			if linked {
				if err := root.Remove(journal.temp()); err != nil {
					return err
				}
			}
		}
	}
	if req.Action == "discard" {
		if err := root.Remove(journal.temp()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := root.Remove(journal.file()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if req.Action == "write" && !journal.Committed {
		if err := transferWrite(root, req, &journal); err != nil {
			return err
		}
	}
	if req.Action == "commit" && !journal.Committed {
		if journal.Offset != journal.Size || req.Digest != transferDigest(strings.Join(journal.Hashes, "")) {
			return transferFail("FILES_TRANSFER_DIGEST")
		}
		hashes, err := transferHashes(root, journal.temp(), journal.Size)
		if err != nil {
			return err
		}
		if transferDigest(strings.Join(hashes, "")) != req.Digest {
			return transferFail("FILES_TRANSFER_DIGEST")
		}
		dest, err := transferStat(root, name)
		if err != nil {
			return err
		}
		if dest.Kind != "missing" && (dest.Kind != "file" || !req.Replace) {
			if dest.Kind != "file" {
				return transferFail("FILES_TRANSFER_TYPE_CONFLICT")
			}
			return transferFail("FILES_TRANSFER_CONFLICT")
		}
		journal.Committing = true
		if err := saveTransferJournal(root, &journal); err != nil {
			return err
		}
		if req.Replace {
			err = root.Rename(journal.temp(), name)
		} else {
			// Link is an atomic no-clobber publish, including a destination created
			// by somebody else after the conflict check.
			err = root.Link(journal.temp(), name)
			if err == nil {
				err = root.Remove(journal.temp())
			}
		}
		if errors.Is(err, os.ErrExist) {
			return transferFail("FILES_TRANSFER_CONFLICT")
		}
		if err != nil {
			return err
		}
		journal.Committed = true
	}
	if err := saveTransferJournal(root, &journal); err != nil {
		return err
	}
	out.Offset, out.Committed = journal.Offset, journal.Committed
	return nil
}

func transferDigest(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func transferWrite(root *os.Root, req protocol.FsTransferRequest, journal *transferJournal) error {
	data, err := base64.StdEncoding.DecodeString(req.Data)
	if err != nil || len(data) > DefaultChunkBytes || req.Offset+len(data) > journal.Size ||
		(req.Offset+len(data) < journal.Size && len(data) != DefaultChunkBytes) ||
		(len(data) == 0 && journal.Size != 0) || req.Offset%DefaultChunkBytes != 0 {
		return transferFail("FILES_TRANSFER_CHUNK")
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	if digest != req.Digest {
		return transferFail("FILES_TRANSFER_DIGEST")
	}
	index := req.Offset / DefaultChunkBytes
	if req.Offset < journal.Offset {
		if index >= len(journal.Hashes) || journal.Hashes[index] != digest {
			return transferFail("FILES_TRANSFER_SOURCE_CHANGED")
		}
		return nil
	}
	if req.Offset != journal.Offset {
		return transferFail("FILES_TRANSFER_OFFSET")
	}
	if info, err := root.Lstat(journal.temp()); err == nil && !info.Mode().IsRegular() {
		return transferFail("FILES_TRANSFER_PATH")
	}
	handle, err := root.OpenFile(journal.temp(), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer handle.Close()
	if _, err := handle.WriteAt(data, int64(req.Offset)); err != nil {
		return err
	}
	if err := handle.Sync(); err != nil {
		return err
	}
	journal.Offset += len(data)
	if len(data) > 0 {
		journal.Hashes = append(journal.Hashes, digest)
	}
	return nil
}

func transferHashes(root *os.Root, name string, size int) ([]string, error) {
	handle, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() != int64(size) {
		return nil, transferFail("FILES_TRANSFER_SOURCE_CHANGED")
	}
	hashes := []string{}
	buf := make([]byte, DefaultChunkBytes)
	for offset := 0; offset < size; {
		n, err := io.ReadFull(handle, buf[:min(DefaultChunkBytes, size-offset)])
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(buf[:n])
		hashes = append(hashes, hex.EncodeToString(sum[:]))
		offset += n
	}
	return hashes, nil
}

func transferStat(root *os.Root, name string) (protocol.FsTransferEntry, error) {
	entry := protocol.NewFsTransferEntry()
	entry.Path, entry.Kind = name, "missing"
	info, err := root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return entry, nil
	}
	if err != nil {
		return entry, err
	}
	entry.Modified = info.ModTime().UTC().Format(time.RFC3339Nano)
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		entry.Kind = "link"
	case info.IsDir():
		entry.Kind = "directory"
	case info.Mode().IsRegular():
		entry.Kind, entry.Size = "file", int(info.Size())
	default:
		entry.Kind = "special"
	}
	return entry, nil
}

func transferList(root *os.Root, name string, offset int, out *protocol.FsTransferResult) error {
	if offset > transferEntryLimit {
		return transferFail("FILES_TRANSFER_LIMIT")
	}
	if err := transferNoLinks(root, name, false); err != nil {
		return err
	}
	handle, err := root.Open(name)
	if err != nil {
		return err
	}
	defer handle.Close()
	// Read at most the cap plus one, sort once per page, and fail instead of
	// truncating. Memory is bounded even when a directory contains millions.
	entries, err := handle.ReadDir(transferEntryLimit + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if len(entries) > transferEntryLimit {
		return transferFail("FILES_TRANSFER_LIMIT")
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries[min(offset, len(entries)):min(offset+250, len(entries))] {
		child := path.Join(name, entry.Name())
		if entry.Name() == transferStateDir || strings.HasPrefix(entry.Name(), ".pdmux-transfer-") {
			continue
		}
		stat, err := transferStat(root, child)
		if err != nil {
			return err
		}
		out.Entries = append(out.Entries, stat)
	}
	if offset+250 < len(entries) {
		next := offset + 250
		out.Next = &next
	}
	return nil
}

func transferRead(root *os.Root, name string, req protocol.FsTransferRequest, out *protocol.FsTransferResult) error {
	if err := transferNoLinks(root, name, false); err != nil {
		return err
	}
	before, err := transferStat(root, name)
	if err != nil {
		return err
	}
	if before.Kind != "file" || before.Size != req.Size || before.Modified != req.Modified {
		return transferFail("FILES_TRANSFER_SOURCE_CHANGED")
	}
	handle, err := root.Open(name)
	if err != nil {
		return err
	}
	defer handle.Close()
	data := make([]byte, min(DefaultChunkBytes, max(0, req.Size-req.Offset)))
	n, err := handle.ReadAt(data, int64(req.Offset))
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if n != len(data) {
		return transferFail("FILES_TRANSFER_SOURCE_CHANGED")
	}
	after, err := transferStat(root, name)
	if err != nil {
		return err
	}
	if after.Modified != before.Modified || after.Size != before.Size {
		return transferFail("FILES_TRANSFER_SOURCE_CHANGED")
	}
	out.Data, out.Offset = base64.StdEncoding.EncodeToString(data[:n]), req.Offset
	out.Entries = append(out.Entries, after)
	return nil
}

func (j transferJournal) file() string {
	return path.Join(transferStateDir, j.TransferID+"-"+j.EntryID+".json")
}
func (j transferJournal) temp() string {
	return path.Join(path.Dir(j.Path), ".pdmux-transfer-"+j.TransferID+"-"+j.EntryID+".part")
}
func ensureTransferState(root *os.Root) error {
	if err := root.Mkdir(transferStateDir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := root.Lstat(transferStateDir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return transferFail("FILES_TRANSFER_STATE")
	}
	return nil
}
func loadTransferJournal(root *os.Root, transferID, entryID string) (transferJournal, error) {
	j := transferJournal{TransferID: transferID, EntryID: entryID}
	handle, err := root.Open(j.file())
	if err != nil {
		return j, err
	}
	defer handle.Close()
	if err := json.NewDecoder(io.LimitReader(handle, 2*1024*1024)).Decode(&j); err != nil {
		return j, err
	}
	_, pathErr := transferPath(j.Path, false)
	if j.Version != 1 || j.TransferID != transferID || j.EntryID != entryID || pathErr != nil ||
		j.Size < 0 || j.Size > transferByteLimit || j.Offset < 0 || j.Offset > j.Size || len(j.Hashes) > 10240 {
		return j, transferFail("FILES_TRANSFER_STATE")
	}
	return j, nil
}
func saveTransferJournal(root *os.Root, j *transferJournal) error {
	j.Updated = time.Now().UnixMilli()
	handle, err := root.OpenFile(j.file()+".next", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(handle).Encode(j)
	if err == nil {
		err = handle.Sync()
	}
	closeErr := handle.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return root.Rename(j.file()+".next", j.file())
}

// CleanupTransfers removes only files named by validated ownership journals.
// Committed destinations are never deleted. It is safe to call after a restart.
func CleanupTransfers(root *os.Root, now time.Time) error {
	transferMu.Lock()
	defer transferMu.Unlock()
	if err := ensureTransferState(root); err != nil {
		return err
	}
	handle, err := root.Open(transferStateDir)
	if err != nil {
		return err
	}
	defer handle.Close()
	for {
		entries, readErr := handle.ReadDir(250)
		for _, entry := range entries {
			name := entry.Name()
			if len(name) != 78 || !strings.HasSuffix(name, ".json") {
				continue
			}
			tid, eid := name[:36], name[37:73]
			if !transferUUID.MatchString(tid) || !transferUUID.MatchString(eid) {
				continue
			}
			j, err := loadTransferJournal(root, tid, eid)
			if err != nil || now.Sub(time.UnixMilli(j.Updated)) < transferTTL {
				continue
			}
			if err := transferNoLinks(root, path.Dir(j.Path), false); err != nil {
				continue
			}
			if err := root.Remove(j.temp()); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if err := root.Remove(j.file()); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}
