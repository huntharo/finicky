package config

import (
	"finicky/util"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestGetConfigPaths(t *testing.T) {
	home, err := util.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		filepath.Join(home, ".finicky.js"),
		filepath.Join(home, ".finicky.ts"),
		filepath.Join(home, ".config/finicky.js"),
		filepath.Join(home, ".config/finicky.ts"),
		filepath.Join(home, ".config/finicky/finicky.js"),
		filepath.Join(home, ".config/finicky/finicky.ts"),
	}
	if got := (&ConfigFileWatcher{}).GetConfigPaths(); !reflect.DeepEqual(got, want) {
		t.Fatalf("default paths/order = %v, want %v", got, want)
	}
	t.Setenv("FINICKY_TEST_CONFIG", "custom.ts")
	custom := &ConfigFileWatcher{customConfigPath: "~/$FINICKY_TEST_CONFIG"}
	if got := custom.GetConfigPaths(); !reflect.DeepEqual(got, []string{filepath.Join(home, "custom.ts")}) {
		t.Fatalf("expanded custom paths = %v", got)
	}
}

func startTestConfigWatcher(t *testing.T, path string) *ConfigFileWatcher {
	t.Helper()
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	cfw := &ConfigFileWatcher{
		watcher: watcher, customConfigPath: path,
		configChangeNotify: make(chan struct{}, 1),
		cache:              &ConfigCache{cachePath: filepath.Join(t.TempDir(), "cache.json")},
	}
	done := make(chan error, 1)
	go func() { done <- cfw.StartWatching() }()
	t.Cleanup(func() {
		cfw.TearDown()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("config watcher did not stop after TearDown")
		}
		cfw.debounceMu.Lock()
		if cfw.debounceTimer != nil {
			cfw.debounceTimer.Stop()
		}
		cfw.debounceMu.Unlock()
	})
	return cfw
}

func writeTestConfig(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("export default { defaultBrowser: 'Safari' };"), 0600); err != nil {
		t.Fatal(err)
	}
}

func awaitConfigDiscovery(t *testing.T, cfw *ConfigFileWatcher, want string) {
	t.Helper()
	select {
	case <-cfw.configChangeNotify:
	case <-time.After(3 * time.Second):
		t.Fatal("config created after startup was not discovered")
	}
	if got, err := cfw.GetConfigPath(false); err != nil || got != want {
		t.Fatalf("config path = %q, %v; want %q", got, err, want)
	}
	// Discovery must switch to a file watch, without adding its parent.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if paths := cfw.watcher.WatchList(); reflect.DeepEqual(paths, []string{want}) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("watch list = %v; want only %q", cfw.watcher.WatchList(), want)
}

func TestMissingConfigDoesNotWatchDirectories(t *testing.T) {
	home := t.TempDir()
	for _, name := range []string{"Music", "Pictures", "Desktop", "Documents", "iCloud"} {
		if err := os.Mkdir(filepath.Join(home, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(home, "Google Drive")); err != nil {
		t.Fatal(err)
	}
	cfw := startTestConfigWatcher(t, filepath.Join(home, ".finicky.ts"))
	// Allow startup and at least one discovery interval; these folders must
	// never be handed to fsnotify, whose kqueue backend opens their children.
	time.Sleep(600 * time.Millisecond)
	if paths := cfw.watcher.WatchList(); len(paths) != 0 {
		t.Fatalf("missing-config discovery watches unrelated directory contents: %v", paths)
	}
	writeTestConfig(t, filepath.Join(home, "unrelated.ts"))
	select {
	case <-cfw.configChangeNotify:
		t.Fatal("unrelated file triggered config discovery")
	case <-time.After(600 * time.Millisecond):
	}
	configPath := filepath.Join(home, ".finicky.ts")
	writeTestConfig(t, configPath)
	awaitConfigDiscovery(t, cfw, configPath)
	writeTestConfig(t, configPath)
	select {
	case <-cfw.configChangeNotify:
	case <-time.After(3 * time.Second):
		t.Fatal("discovered config is not watched for subsequent writes")
	}
}

func TestMissingConfigDiscoversNewParents(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".config", "finicky", "finicky.ts")
	cfw := startTestConfigWatcher(t, path)
	time.Sleep(100 * time.Millisecond)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	writeTestConfig(t, path)
	awaitConfigDiscovery(t, cfw, path)
}

func TestMissingConfigDiscoversSymlinkTarget(t *testing.T) {
	target := filepath.Join(t.TempDir(), "config.ts")
	path := filepath.Join(t.TempDir(), ".finicky.ts")
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	cfw := startTestConfigWatcher(t, path)
	time.Sleep(100 * time.Millisecond)
	writeTestConfig(t, target)
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	awaitConfigDiscovery(t, cfw, resolved)
}

func TestGetConfigPathCustom(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom.js")
	cfw := &ConfigFileWatcher{customConfigPath: path}
	if got, err := cfw.GetConfigPath(false); err == nil || got != "" {
		t.Fatalf("missing custom config = %q, %v; want error without fallback", got, err)
	}
	writeTestConfig(t, path)
	if got, err := cfw.GetConfigPath(false); err != nil || got != path {
		t.Fatalf("custom config = %q, %v; want %q", got, err, path)
	}
}
