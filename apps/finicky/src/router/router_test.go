package router

import (
	"bytes"
	"encoding/json"
	"finicky/browser"
	"finicky/diagnostics"
	"finicky/rules"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newTestEngine(t *testing.T, js string) *Engine {
	t.Helper()
	dir := t.TempDir()
	var path string
	if js != "" {
		path = filepath.Join(dir, "config.ts")
		if err := os.WriteFile(path, []byte(js), 0600); err != nil {
			t.Fatal(err)
		}
	}
	e, err := New(Options{DataDir: dir, ConfigPath: path, Version: "test", Browsers: []string{"Safari", "Firefox"}, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Close)
	return e
}
func resolveBrowser(t *testing.T, e *Engine) string {
	t.Helper()
	result, err := e.Resolve("https://example.com/somewhere", nil, false)
	if err != nil || result.Error != "" {
		t.Fatalf("resolve: %+v, %v", result, err)
	}
	return result.Browser
}
func eventually(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("timed out waiting for reload")
}
func atomicReplace(t *testing.T, path, contents string) {
	t.Helper()
	tmp := path + ".new"
	if err := os.WriteFile(tmp, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}

func TestCandidateValidationAndAtomicSaveRecovery(t *testing.T) {
	e := newTestEngine(t, `export default { defaultBrowser: "Safari" };`)
	if got := resolveBrowser(t, e); got != "Safari" {
		t.Fatal(got)
	}
	path := e.Snapshot().ConfigPath
	atomicReplace(t, path, `export default {defaultBrowser:"Firefox",handlers:[{match:42,browser:"Firefox"}]};`)
	eventually(t, func() bool { return e.Snapshot().ConfigError != "" })
	if !strings.Contains(e.Snapshot().ConfigError, "handlers[0].match") {
		t.Fatal(e.Snapshot().ConfigError)
	}
	if got := resolveBrowser(t, e); got != "Safari" {
		t.Fatalf("invalid config replaced last good VM: %s", got)
	}
	atomicReplace(t, path, `export default {defaultBrowser:"Firefox"};`)
	eventually(t, func() bool {
		return e.Snapshot().ConfigError == "" && e.Snapshot().ConfigState.DefaultBrowser == "Firefox"
	})
	if got := resolveBrowser(t, e); got != "Firefox" {
		t.Fatal(got)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return e.Snapshot().ConfigError != "" })
	if got := resolveBrowser(t, e); got != "Firefox" {
		t.Fatal(got)
	}
	atomicReplace(t, path, `export default {defaultBrowser:"Safari"};`)
	eventually(t, func() bool {
		return e.Snapshot().ConfigError == "" && e.Snapshot().ConfigState.DefaultBrowser == "Safari"
	})
}

func TestVisualRulesTransactionAndReload(t *testing.T) {
	e := newTestEngine(t, "")
	rf := rules.RulesFile{DefaultBrowser: "Safari", Rules: []rules.Rule{{Match: []string{"example.com/*"}, Browser: "Firefox", Profile: "Work"}}}
	if _, err := e.SaveRules(rf); err != nil {
		t.Fatal(err)
	}
	if got := resolveBrowser(t, e); got != "Firefox" {
		t.Fatal(got)
	}
	before, _ := os.ReadFile(e.rulesPath)
	rf.Rules[0].Browser = "PwrFinicky"
	if _, err := e.SaveRules(rf); err == nil {
		t.Fatal("self-routing rule accepted")
	}
	after, _ := os.ReadFile(e.rulesPath)
	if !bytes.Equal(before, after) {
		t.Fatal("rejected save changed disk")
	}
	atomicReplace(t, e.rulesPath, `{"defaultBrowser":`)
	eventually(t, func() bool { return e.Snapshot().ConfigError != "" })
	if got := resolveBrowser(t, e); got != "Firefox" {
		t.Fatal(got)
	}
	atomicReplace(t, e.rulesPath, `{"defaultBrowser":"Safari","rules":[]}`)
	eventually(t, func() bool {
		return e.Snapshot().ConfigError == "" && e.Snapshot().ConfigState.DefaultBrowser == "Safari"
	})
}

func TestMetadataNeverCallsBrowserFunction(t *testing.T) {
	e := newTestEngine(t, `export default {defaultBrowser: (url, options) => { if (!url || url.host === "example.com") throw new Error("metadata must not invoke me"); return "Firefox"; }};`)
	if e.Snapshot().ConfigError != "" || !e.Snapshot().IsJSConfig {
		t.Fatal(e.Snapshot())
	}
	result, err := e.Resolve("https://actual.test/", nil, false)
	if err != nil || result.Error != "" || result.Browser != "Firefox" {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestDirectoryConfigRejectedWithoutLosingSnapshot(t *testing.T) {
	e := newTestEngine(t, "")
	dir := filepath.Join(e.options.DataDir, "finicky.ts")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "unrelated"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SetConfig(dir); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("expected regular-file guard, got %v", err)
	}
	if got := resolveBrowser(t, e); got != "Safari" {
		t.Fatal(got)
	}
}

func TestImportedDependencyReload(t *testing.T) {
	e := newTestEngine(t, "")
	dir := e.options.DataDir
	dependency := filepath.Join(dir, "browser.ts")
	path := filepath.Join(dir, "config.ts")
	atomicReplace(t, dependency, `export default "Safari";`)
	atomicReplace(t, path, `import browser from "./browser"; export default {defaultBrowser:browser};`)
	if _, err := e.SetConfig(path); err != nil {
		t.Fatal(err)
	}
	atomicReplace(t, dependency, `export default "Firefox";`)
	eventually(t, func() bool { return e.Snapshot().ConfigState.DefaultBrowser == "Firefox" })
}

func TestConcurrentReadersAndConfigWrites(t *testing.T) {
	e := newTestEngine(t, "")
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 15; j++ {
				e.Resolve("https://example.com", nil, false)
				e.Snapshot()
			}
		}()
	}
	for i := 0; i < 8; i++ {
		_, err := e.SaveRules(rules.RulesFile{DefaultBrowser: "Firefox", Rules: []rules.Rule{}})
		if err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
	if len(e.Snapshot().History) != 60 {
		t.Fatal("lost dispatches")
	}
}

func TestJSInitializationDeadline(t *testing.T) {
	e := newTestEngine(t, "")
	path := filepath.Join(e.options.DataDir, "loop.js")
	atomicReplace(t, path, `while(true){}; export default {defaultBrowser:"Firefox"};`)
	start := time.Now()
	if _, err := e.SetConfig(path); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected deadline error: %v", err)
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("initialization deadline ineffective")
	}
	if got := resolveBrowser(t, e); got != "Safari" {
		t.Fatal(got)
	}
}

func TestDispatchUsesExplicitLauncherAndDryRun(t *testing.T) {
	var calls atomic.Int32
	e, err := New(Options{DataDir: t.TempDir(), Browsers: []string{"Firefox"}, DryRun: true, Launch: func(cfg browser.BrowserConfig, dryRun, bg bool, trace *diagnostics.Trace) error {
		calls.Add(1)
		if cfg.Name != "Firefox" || !dryRun {
			t.Errorf("unexpected launch: %+v dry=%v", cfg, dryRun)
		}
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.Resolve("https://example.com", nil, false)
	if calls.Load() != 0 {
		t.Fatal("URL test launched browser")
	}
	e.Resolve("https://example.com", nil, true)
	if calls.Load() != 1 {
		t.Fatal("dispatch did not launch")
	}
	if !e.Snapshot().History[0].DryRun {
		t.Fatal("global dry-run not retained")
	}
}

func TestAuthenticatedServerHasNoStartupDefaultRegistration(t *testing.T) {
	e := newTestEngine(t, "")
	var defaults atomic.Int32
	server, err := StartServer(e, Controls{SetDefaultBrowser: func() (any, error) { defaults.Add(1); return map[string]bool{"isDefault": true}, nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	info, err := os.Stat(server.Path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Fatal("endpoint secret is not private")
	}
	request := func(token, origin, method string) *http.Response {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"method": method, "params": map[string]any{}})
		req, _ := http.NewRequest("POST", server.Endpoint.URL+"/rpc", bytes.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { res.Body.Close() })
		return res
	}
	if got := request("", "", "state").StatusCode; got != 401 {
		t.Fatal(got)
	}
	if got := request(server.Endpoint.Token, "https://example.com", "state").StatusCode; got != 401 {
		t.Fatal(got)
	}
	res := request(server.Endpoint.Token, "", "state")
	if res.StatusCode != 200 {
		data, _ := io.ReadAll(res.Body)
		t.Fatal(string(data))
	}
	if defaults.Load() != 0 {
		t.Fatal("read-only state registered default browser")
	}
	if got := request(server.Endpoint.Token, "", "setDefaultBrowser").StatusCode; got != 200 {
		t.Fatal(got)
	}
	if defaults.Load() != 1 {
		t.Fatal("explicit registration action not forwarded")
	}
}
