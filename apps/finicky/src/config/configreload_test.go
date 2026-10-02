package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeConfig(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func awaitChange(t *testing.T, changes <-chan struct{}) {
	t.Helper()
	select {
	case <-changes:
	case <-time.After(4 * time.Second):
		t.Fatal("configuration change was not detected")
	}
}

// Instrument every lifecycle transition: only the exact discovered file may
// be registered. A missing path must leave the watch list empty.
func assertExactFileWatches(t *testing.T, watcher *ConfigFileWatcher) {
	t.Helper()
	selected, selectedErr := watcher.GetConfigPath(false)
	for _, path := range watcher.watcher.WatchList() {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stale watch %q: %v", path, err)
		}
		if !info.Mode().IsRegular() {
			t.Fatalf("directory/non-file watch registered: %q", path)
		}
		if selectedErr != nil || path != selected {
			t.Fatalf("watch %q is not the exact selected config %q (%v)", path, selected, selectedErr)
		}
	}
}

func TestWatcherDeleteAndRecreate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "finicky.ts")
	writeConfig(t, path, `export default {defaultBrowser: "Safari"}`)
	changes := make(chan struct{}, 1)
	watcher, err := NewConfigFileWatcher(path, "finickyConfig", changes)
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.TearDown()
	assertExactFileWatches(t, watcher)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	awaitChange(t, changes)
	assertExactFileWatches(t, watcher)
	writeConfig(t, path, `export default {defaultBrowser: "Firefox"}`)
	awaitChange(t, changes)
	assertExactFileWatches(t, watcher)
}

func TestWatcherAtomicSavesAndSymlinkRetarget(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.ts")
	second := filepath.Join(dir, "second.ts")
	path := filepath.Join(dir, "finicky.ts")
	writeConfig(t, first, `export default {defaultBrowser: "Safari"}`)
	writeConfig(t, second, `export default {defaultBrowser: "Firefox"}`)
	if err := os.Symlink(first, path); err != nil {
		t.Fatal(err)
	}
	changes := make(chan struct{}, 1)
	watcher, err := NewConfigFileWatcher(path, "finickyConfig", changes)
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.TearDown()
	assertExactFileWatches(t, watcher)
	// Two consecutive inode replacements must both be noticed.
	for _, browser := range []string{"Chrome", "Firefox"} {
		tmp := filepath.Join(dir, "save.ts")
		writeConfig(t, tmp, `export default {defaultBrowser: "`+browser+`"}`)
		// Preserve mtime and size to ensure inode replacement invalidates cache.
		info, err := os.Stat(first)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(tmp, info.ModTime(), info.ModTime()); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, first); err != nil {
			t.Fatal(err)
		}
		awaitChange(t, changes)
		assertExactFileWatches(t, watcher)
	}
	link := filepath.Join(dir, "new-link")
	if err := os.Symlink(second, link); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(link, path); err != nil {
		t.Fatal(err)
	}
	awaitChange(t, changes)
	assertExactFileWatches(t, watcher)
	writeConfig(t, second, `export default {defaultBrowser: "Chrome"}`)
	awaitChange(t, changes)
	assertExactFileWatches(t, watcher)
}

func TestWatcherTearDownCancelsPendingNotification(t *testing.T) {
	path := filepath.Join(t.TempDir(), "finicky.ts")
	writeConfig(t, path, `export default {defaultBrowser: "Safari"}`)
	changes := make(chan struct{}, 1)
	watcher, err := NewConfigFileWatcher(path, "finickyConfig", changes)
	if err != nil {
		t.Fatal(err)
	}
	writeConfig(t, path, `export default {defaultBrowser: "Firefox"}`)
	watcher.TearDown()
	watcher.TearDown()
	select {
	case <-changes:
		t.Fatal("notification after watcher teardown")
	case <-time.After(700 * time.Millisecond):
	}
}

func TestChangedBundleValidatedBeforeUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "finicky.ts")
	changes := make(chan struct{}, 1)
	watcher, err := NewConfigFileWatcher(path, "finickyConfig", changes)
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.TearDown()
	assertExactFileWatches(t, watcher)
	// Isolate test cache persistence from the user's running app.
	watcher.cache = &ConfigCache{cachePath: filepath.Join(t.TempDir(), "cache.json"), appVersion: "test"}
	load := func() (*VM, error) {
		bundle, _, err := watcher.BundleConfig()
		if err != nil {
			return nil, err
		}
		return New(configAPI(t), "finickyConfig", bundle)
	}
	writeConfig(t, path, `export default {defaultBrowser: "Safari"}`)
	awaitChange(t, changes)
	assertExactFileWatches(t, watcher)
	active, err := load()
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		`export default {`,
		`throw new Error("bad edit"); export default {defaultBrowser: "Firefox"}`,
		`export default {defaultBrowser: "Firefox", handlers: [{match: 42, browser: "Chrome"}]}`,
	} {
		writeConfig(t, path, invalid)
		awaitChange(t, changes)
		assertExactFileWatches(t, watcher)
		if candidate, err := load(); err == nil || candidate != nil {
			t.Fatalf("bad edit accepted: %v %v", candidate, err)
		}
		if state := active.GetConfigState(); state.DefaultBrowser != "Safari" {
			t.Fatalf("last good runtime changed: %+v", state)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	awaitChange(t, changes)
	assertExactFileWatches(t, watcher)
	if candidate, err := load(); err == nil || candidate != nil {
		t.Fatalf("missing config accepted: %v %v", candidate, err)
	}
	writeConfig(t, path, `export default {defaultBrowser: "Firefox"}`)
	awaitChange(t, changes)
	assertExactFileWatches(t, watcher)
	candidate, err := load()
	if err != nil {
		t.Fatal(err)
	}
	if state := candidate.GetConfigState(); state.DefaultBrowser != "Firefox" {
		t.Fatalf("recovery did not use new content: %+v", state)
	}
}

func TestBundleExportFormats(t *testing.T) {
	for _, tc := range []struct{ name, filename, script string }{
		{"ES module JavaScript", "finicky.js", `export default {defaultBrowser: "Safari", handlers: [{match: /(?<host>example)/, browser: "Firefox"}]}`},
		{"legacy CommonJS", "finicky.js", `module.exports = {defaultBrowser: "Safari"}`},
		{"TypeScript", "finicky.ts", `const browser: string = "Safari"; export default {defaultBrowser: browser}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, tc.filename)
			writeConfig(t, path, tc.script)
			watcher := &ConfigFileWatcher{
				customConfigPath: path, namespace: "finickyConfig",
				cache: &ConfigCache{cachePath: filepath.Join(dir, "cache.json"), appVersion: "test"},
			}
			bundle, _, err := watcher.BundleConfig()
			if err != nil {
				t.Fatal(err)
			}
			vm, err := New(configAPI(t), "finickyConfig", bundle)
			if err != nil {
				t.Fatal(err)
			}
			if state := vm.GetConfigState(); state.DefaultBrowser != "Safari" {
				t.Fatalf("export not loaded: %+v", state)
			}
		})
	}
}

func TestWatcherNeverRegistersDirectoryCandidate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "finicky.ts")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	writeConfig(t, filepath.Join(path, "unrelated.ts"), "unrelated protected fixture")
	changes := make(chan struct{}, 1)
	watcher, err := NewConfigFileWatcher(path, "finickyConfig", changes)
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.TearDown()
	if paths := watcher.watcher.WatchList(); len(paths) != 0 {
		t.Fatalf("directory watch registered at startup: %v", paths)
	}
	// A directory at a candidate path must stay on the exact-path polling fallback.
	time.Sleep(700 * time.Millisecond)
	if paths := watcher.watcher.WatchList(); len(paths) != 0 {
		t.Fatalf("directory watch registered by polling fallback: %v", paths)
	}
}
