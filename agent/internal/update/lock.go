package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

// BUSY is enforced twice, and both halves are needed.
//
//	IN-PROCESS (a mutex, in update.go) is what makes the server's retry safe: the
//	same commandId re-emits the current phase and starts no second download.
//
//	CROSS-PROCESS (this file, an O_EXCL lock file) is what makes the SWAP safe.
//	During an update there are routinely two agent processes on the host — the
//	old one that is updating, and, moments later, the new one the service manager
//	started. Add a `pdmux-agent run` somebody left in a terminal and the mutex,
//	which only knows about one address space, protects nothing. Two processes
//	link/renaming the same executable can leave `.bak` naming the binary that is
//	already replaced — which is a rollback to the broken build.
const lockFile = "update.lock"

type lockRecord struct {
	CommandID string `json:"commandId"`
	PID       int    `json:"pid"`
	StartedAt int64  `json:"startedAt"`
}

// acquireLock takes the cross-process lock. On refusal it returns the commandId
// of whoever holds it, so the caller can tell "my own job, elsewhere" from
// "somebody else's job" — the first is idempotency, the second is BUSY.
func acquireLock(dir, commandID string, pid int, now time.Time) (release func(), holder string, err error) {
	if err := state.EnsureDir(dir); err != nil {
		return nil, "", err
	}
	path := filepath.Join(dir, lockFile)
	record, err := json.Marshal(lockRecord{CommandID: commandID, PID: pid, StartedAt: now.Unix()})
	if err != nil {
		return nil, "", err
	}

	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, state.FileMode)
		if err == nil {
			_, writeErr := file.Write(record)
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				_ = os.Remove(path)
				return nil, "", errors.Join(writeErr, closeErr)
			}
			return func() { _ = os.Remove(path) }, "", nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, "", err
		}

		existing, readErr := readLock(path)
		if readErr != nil || !processAlive(existing.PID) {
			// STALE. A lock file outlives the process that made it — the update path
			// ends in exit(0), and a kill -9 or a power cut ends it without any exit
			// at all. Refusing forever would mean a host that can never be updated
			// again without somebody deleting a file by hand, which is precisely the
			// "walk to the machine" outcome this package exists to avoid.
			//
			// The cost of being wrong is bounded by the mutex and by the fact that
			// pid reuse would have to hit an agent process specifically.
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, "", err
			}
			continue
		}
		return nil, existing.CommandID, fmt.Errorf("held by pid %d", existing.PID)
	}
	return nil, "", errors.New("could not take the update lock")
}

func readLock(path string) (lockRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return lockRecord{}, err
	}
	var record lockRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return lockRecord{}, err
	}
	return record, nil
}

// processAlive answers "is that pid still there".
//
// Signal 0 is the portable "check, do not deliver". The error cases matter more
// than the success one: ESRCH (and Go's ErrProcessDone) mean gone, EPERM means
// it exists and belongs to somebody else — alive. Anything we cannot classify is
// treated as ALIVE, because refusing an update is recoverable and stealing a
// live lock is not.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	switch {
	case err == nil:
		return true
	case errors.Is(err, os.ErrProcessDone), errors.Is(err, syscall.ESRCH):
		return false
	default:
		return true
	}
}
