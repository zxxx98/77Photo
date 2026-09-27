package maintenance

import (
	"errors"
	"testing"
)

func TestLockAdmitsOneActivityAndReportsHolder(t *testing.T) {
	lock := &Lock{}
	release, err := lock.Acquire(KindImport, "import_1")
	if err != nil {
		t.Fatal(err)
	}
	_, err = lock.Acquire(KindRescan, "rescan_1")
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("second Acquire error = %v, want ErrBusy", err)
	}
	if details := Details(err); details["kind"] != KindImport || details["job_id"] != "import_1" {
		t.Fatalf("details = %#v, want import_1 holder", details)
	}
	if active, ok := lock.Current(); !ok || active.Kind != KindImport {
		t.Fatalf("Current() = %+v, %v", active, ok)
	}

	release()
	release()
	if _, ok := lock.Current(); ok {
		t.Fatal("lock still held after release")
	}
	next, err := lock.Acquire(KindCleanup, "")
	if err != nil {
		t.Fatalf("Acquire after release error = %v", err)
	}
	// A stale release from the previous holder must not free the new one.
	release()
	if active, ok := lock.Current(); !ok || active.Kind != KindCleanup {
		t.Fatalf("Current() after stale release = %+v, %v", active, ok)
	}
	next()
}

func TestNilLockAdmitsEverything(t *testing.T) {
	var lock *Lock
	release, err := lock.Acquire(KindRescan, "r")
	if err != nil {
		t.Fatal(err)
	}
	release()
	if _, ok := lock.Current(); ok {
		t.Fatal("nil lock reported an active holder")
	}
}
