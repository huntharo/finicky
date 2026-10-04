package urlhandlers

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeRegistry struct {
	handlers     map[string]string
	failScheme   string
	failRegister bool
	ignoreWrites bool
	writes       int
}

func (r *fakeRegistry) Handler(s string) (string, error) { return r.handlers[s], nil }
func (r *fakeRegistry) Register(string) error {
	if r.failRegister {
		return errors.New("registration failed")
	}
	return nil
}
func (r *fakeRegistry) SetHandler(s, app string) error {
	r.writes++
	if !r.ignoreWrites {
		r.handlers[s] = app
	}
	if s == r.failScheme {
		return errors.New("setter failed after changing handler")
	}
	return nil
}
func fixture(t *testing.T) (*fakeRegistry, string, string) {
	t.Helper()
	return &fakeRegistry{handlers: map[string]string{
		"http":    "/Applications/Finicky.app",
		"https":   "/Applications/Safari.app",
		"finicky": "/Applications/Finicky.app",
	}}, "/worktree/Finicky-Dev.app", filepath.Join(t.TempDir(), "state.json")
}
func TestSwitchRestoreExactPaths(t *testing.T) {
	r, app, state := fixture(t)
	if err := Switch(r, app, state); err != nil {
		t.Fatal(err)
	}
	for _, s := range Schemes {
		if r.handlers[s] != app {
			t.Fatalf("%s not switched", s)
		}
	}
	info, err := os.Stat(state)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("state must be private and present")
	}
	if err := Restore(r, app, state); err != nil {
		t.Fatal(err)
	}
	if r.handlers["http"] != "/Applications/Finicky.app" || r.handlers["https"] != "/Applications/Safari.app" || r.handlers["finicky"] != "/Applications/Finicky.app" {
		t.Fatal("original application paths not restored")
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatal("completed restore must remove snapshot")
	}
}
func TestPartialSwitchAndRestoreRetry(t *testing.T) {
	r, app, state := fixture(t)
	r.failScheme = "https"
	if err := Switch(r, app, state); err == nil {
		t.Fatal("expected switch failure")
	}
	if _, err := os.Stat(state); err != nil {
		t.Fatal("must retain recovery state")
	}
	if err := Restore(r, app, state); err == nil {
		t.Fatal("expected partial restore failure")
	}
	r.failScheme = ""
	if err := Restore(r, app, state); err != nil {
		t.Fatal(err)
	}
	if r.handlers["http"] != "/Applications/Finicky.app" || r.handlers["https"] != "/Applications/Safari.app" {
		t.Fatal("retry did not restore paths")
	}
}
func TestExternalChangeRefusesAllWrites(t *testing.T) {
	r, app, state := fixture(t)
	if err := Switch(r, app, state); err != nil {
		t.Fatal(err)
	}
	r.handlers["finicky"] = "/other/App.app"
	writes := r.writes
	if err := Restore(r, app, state); err == nil {
		t.Fatal("must refuse external change")
	}
	if r.writes != writes {
		t.Fatal("must validate all associations before restoring any")
	}
	if _, err := os.Stat(state); err != nil {
		t.Fatal("must preserve recovery state")
	}
}
func TestExistingStateIsNeverOverwritten(t *testing.T) {
	r, app, state := fixture(t)
	original := []byte("previous recovery state")
	if err := os.WriteFile(state, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := Switch(r, app, state); err == nil {
		t.Fatal("must refuse existing state")
	}
	contents, _ := os.ReadFile(state)
	if string(contents) != string(original) || r.writes != 0 {
		t.Fatal("existing state or defaults modified")
	}
}
func TestMissingOriginalHandlerRefusesMutation(t *testing.T) {
	r, app, state := fixture(t)
	r.handlers["finicky"] = ""
	if err := Switch(r, app, state); err == nil {
		t.Fatal("must preserve restorable associations")
	}
	if r.writes != 0 {
		t.Fatal("unexpected registry mutation")
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatal("must not save incomplete snapshot")
	}
}
func TestVerificationFailureLeavesRecoveryState(t *testing.T) {
	r, app, state := fixture(t)
	r.ignoreWrites = true
	if err := Switch(r, app, state); err == nil {
		t.Fatal("must detect ignored setter")
	}
	if err := Restore(r, app, state); err != nil {
		t.Fatal(err)
	}
}
func TestRegistrationFailureCanRestore(t *testing.T) {
	r, app, state := fixture(t)
	r.failRegister = true
	if err := Switch(r, app, state); err == nil {
		t.Fatal("expected register failure")
	}
	if r.writes != 0 {
		t.Fatal("must not switch after registration failure")
	}
	if err := Restore(r, app, state); err != nil {
		t.Fatal(err)
	}
}
func TestWrongWorktreeCannotRestore(t *testing.T) {
	r, app, state := fixture(t)
	if err := Switch(r, app, state); err != nil {
		t.Fatal(err)
	}
	writes := r.writes
	if err := Restore(r, "/other/Finicky-Dev.app", state); err == nil {
		t.Fatal("must refuse different worktree")
	}
	if r.writes != writes {
		t.Fatal("unexpected registry mutation")
	}
}
