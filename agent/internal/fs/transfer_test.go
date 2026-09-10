package fs

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

func transferRequest(action, name string) protocol.FsTransferRequest {
	return protocol.FsTransferRequest{
		RequestID:  "11111111-1111-4111-8111-111111111111",
		TransferID: "22222222-2222-4222-8222-222222222222",
		EntryID:    "33333333-3333-4333-8333-333333333333",
		Action:     action, Path: name,
	}
}
func transferOK(t *testing.T, root *os.Root, req protocol.FsTransferRequest) protocol.FsTransferResult {
	t.Helper()
	result := Transfer(root, req)
	if result.Error != nil {
		t.Fatalf("%s: %s", req.Action, *result.Error)
	}
	return result
}

func TestTransfers(t *testing.T) {
	t.Run("[TC-PDFILE-001] preserve empty folders and page without truncation", testTransferPathsAndPaging)
	t.Run("[TC-PDFILE-002] retry chunks and publish without truncation", testTransferDurablePublish)
	t.Run("[TC-PDFILE-002] zero-byte commit and owned staging expiry", testTransferEmptyAndExpiry)
	t.Run("[TC-PDFILE-002] recover an interrupted atomic link publication", testTransferLinkedRecovery)
	t.Run("[TC-PDFILE-001] preserve Unicode and spaces and reject source changes", testTransferStableRead)
}

func testTransferPathsAndPaging(t *testing.T) {
	home := t.TempDir()
	root, err := Open(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	transferOK(t, root, transferRequest("mkdir", "folder/empty"))
	for i := 0; i < 1001; i++ {
		if err := os.WriteFile(filepath.Join(home, "folder", fmt.Sprintf("%04d", i)), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	req := transferRequest("list", "folder")
	count := 0
	for {
		result := transferOK(t, root, req)
		if len(result.Entries) > 250 {
			t.Fatal("unbounded page")
		}
		count += len(result.Entries)
		if result.Next == nil {
			break
		}
		req.Offset = *result.Next
	}
	if count != 1002 {
		t.Fatalf("lost entries: %d", count)
	}
	for _, name := range []string{"../escape", "/absolute", "C:\\escape", "folder/../escape", "folder//escape", ".pdmux-file-transfers/escape"} {
		if Transfer(root, transferRequest("mkdir", name)).Error == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	if err := os.Symlink("folder", filepath.Join(home, "link")); err != nil {
		t.Fatal(err)
	}
	if Transfer(root, transferRequest("mkdir", "link/unsafe")).Error == nil {
		t.Fatal("followed link")
	}
}

func testTransferDurablePublish(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "target"), []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := Open(home)
	if err != nil {
		t.Fatal(err)
	}
	req := transferRequest("write", "target")
	data := strings.Repeat("x", DefaultChunkBytes)
	req.Size, req.Data, req.Digest = len(data)+4, base64.StdEncoding.EncodeToString([]byte(data)), transferDigest(data)
	first := transferOK(t, root, req)
	if first.Offset != len(data) {
		t.Fatal(first.Offset)
	}
	if transferOK(t, root, req).Offset != len(data) {
		t.Fatal("duplicate advanced offset")
	}
	bad := req
	bad.Digest = transferDigest("different")
	if Transfer(root, bad).Error == nil {
		t.Fatal("accepted bad digest")
	}
	root.Close()
	root, err = Open(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	stat := req
	stat.Action = "stat"
	if transferOK(t, root, stat).Offset != len(data) {
		t.Fatal("lost durable offset")
	}
	req.Offset, req.Data, req.Digest = len(data), base64.StdEncoding.EncodeToString([]byte("tail")), transferDigest("tail")
	transferOK(t, root, req)
	req.Action, req.Digest = "commit", transferDigest(transferDigest(data)+transferDigest("tail"))
	if Transfer(root, req).Error == nil {
		t.Fatal("overwrote without consent")
	}
	original, err := os.ReadFile(filepath.Join(home, "target"))
	if err != nil || string(original) != "original" {
		t.Fatal("changed original before commit")
	}
	req.Replace = true
	if !transferOK(t, root, req).Committed {
		t.Fatal("not committed")
	}
	if !transferOK(t, root, req).Committed {
		t.Fatal("commit is not idempotent")
	}
	saved, err := os.ReadFile(filepath.Join(home, "target"))
	if err != nil || string(saved) != data+"tail" {
		t.Fatal("corrupt output")
	}
	req.Action = "discard"
	transferOK(t, root, req)
	saved, err = os.ReadFile(filepath.Join(home, "target"))
	if err != nil || string(saved) != data+"tail" {
		t.Fatal("cancel removed committed file")
	}
}

func testTransferEmptyAndExpiry(t *testing.T) {
	home := t.TempDir()
	root, err := Open(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	req := transferRequest("write", "empty")
	req.Digest = transferDigest("")
	transferOK(t, root, req)
	req.Action = "commit"
	transferOK(t, root, req)
	req = transferRequest("write", "pending")
	req.EntryID = "44444444-4444-4444-8444-444444444444"
	req.Size, req.Data, req.Digest = 1, base64.StdEncoding.EncodeToString([]byte("a")), transferDigest("a")
	transferOK(t, root, req)
	if err := CleanupTransfers(root, time.Now().Add(25*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if info, err := root.Stat("empty"); err != nil || info.Size() != 0 {
		t.Fatal("removed committed empty file")
	}
	j := transferJournal{TransferID: req.TransferID, EntryID: req.EntryID, Path: req.Path}
	if _, err := root.Stat(j.temp()); !os.IsNotExist(err) {
		t.Fatal("retained expired stage")
	}
	if _, err := root.Stat("pending"); !os.IsNotExist(err) {
		t.Fatal("published uncommitted data")
	}
}

func testTransferLinkedRecovery(t *testing.T) {
	root, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	req := transferRequest("write", "file")
	req.Size, req.Data, req.Digest = 1, base64.StdEncoding.EncodeToString([]byte("x")), transferDigest("x")
	transferOK(t, root, req)
	j, err := loadTransferJournal(root, req.TransferID, req.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	j.Committing = true
	if err := saveTransferJournal(root, &j); err != nil {
		t.Fatal(err)
	}
	if err := root.Link(j.temp(), j.Path); err != nil {
		t.Fatal(err)
	}
	req.Action = "stat"
	if !transferOK(t, root, req).Committed {
		t.Fatal("lost published state")
	}
	if _, err := root.Stat(j.temp()); !os.IsNotExist(err) {
		t.Fatal("retained duplicate stage")
	}
}

func testTransferStableRead(t *testing.T) {
	home := t.TempDir()
	root, err := Open(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	name := " \u6587\u4ef6 "
	if err := os.WriteFile(filepath.Join(home, name), []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	info := transferOK(t, root, transferRequest("stat", name)).Entries[0]
	req := transferRequest("read", name)
	req.Size, req.Modified = info.Size, info.Modified
	if transferOK(t, root, req).Data != base64.StdEncoding.EncodeToString([]byte("payload")) {
		t.Fatal("changed path or bytes")
	}
	if err := os.WriteFile(filepath.Join(home, name), []byte("changed length"), 0o600); err != nil {
		t.Fatal(err)
	}
	if Transfer(root, req).Error == nil {
		t.Fatal("read a changed source")
	}
	if err := os.Symlink(name, filepath.Join(home, "link")); err != nil {
		t.Fatal(err)
	}
	if transferOK(t, root, transferRequest("stat", "link")).Entries[0].Kind != "link" {
		t.Fatal("did not report excluded link")
	}
}
