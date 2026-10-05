// Package router owns PwrFinicky's active configuration independently of its UI.
// Every Goja access is serialized. File changes are compiled and validated in a
// candidate runtime before publication; URL dispatch only reads that snapshot.
package router

import (
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"finicky/browser"
	"finicky/config"
	"finicky/diagnostics"
	"finicky/resolver"
	"finicky/rules"
	"github.com/evanw/esbuild/pkg/api"
)

//go:embed config-api.js
var configAPI []byte

const namespace = "finickyConfig"
const maxConfigSize = 4 << 20

type Options struct {
	DataDir    string
	ConfigPath string
	Version    string
	DryRun     bool
	Launch     func(browser.BrowserConfig, bool, bool, *diagnostics.Trace) error
	Browsers   []string
}

type History struct {
	ID         string  `json:"id"`
	Time       string  `json:"time"`
	URL        string  `json:"url"`
	Browser    string  `json:"browser"`
	Profile    string  `json:"profile"`
	DurationMS float64 `json:"durationMs"`
	ResolveMS  float64 `json:"resolveMs"`
	LaunchMS   float64 `json:"launchMs"`
	DryRun     bool    `json:"dryRun"`
	Success    bool    `json:"success"`
	Error      string  `json:"error,omitempty"`
	Source     string  `json:"source,omitempty"`
}

type Snapshot struct {
	Version      string              `json:"version"`
	Platform     string              `json:"platform"`
	BackendPID   int                 `json:"backendPid"`
	ConfigPath   string              `json:"configPath"`
	RulesPath    string              `json:"rulesPath"`
	ConfigError  string              `json:"configError"`
	IsJSConfig   bool                `json:"isJSConfig"`
	ConfigState  *config.ConfigState `json:"configState"`
	Rules        rules.RulesFile     `json:"rules"`
	Browsers     []string            `json:"browsers"`
	History      []History           `json:"history"`
	Capabilities map[string]bool     `json:"capabilities"`
}

type Result struct {
	URL              string   `json:"url"`
	Browser          string   `json:"browser"`
	Profile          string   `json:"profile"`
	Args             []string `json:"args"`
	OpenInBackground bool     `json:"openInBackground"`
	DurationMS       float64  `json:"durationMs"`
	LaunchMS         float64  `json:"launchMs"`
	Error            string   `json:"error,omitempty"`
}

type preferences struct {
	ConfigPath string `json:"configPath"`
}

type Engine struct {
	mu             sync.Mutex
	options        Options
	vm             *config.VM
	selectedConfig string
	rulesPath      string
	activeRules    rules.RulesFile
	configError    string
	browsers       []string
	history        []History
	dependencies   []string
	fingerprint    string
	stop           chan struct{}
	done           chan struct{}
	closeOnce      sync.Once
}

func New(options Options) (*Engine, error) {
	if options.DataDir == "" {
		return nil, errors.New("data directory is required")
	}
	if err := os.MkdirAll(options.DataDir, 0700); err != nil {
		return nil, err
	}
	if options.Launch == nil {
		options.Launch = browser.LaunchBrowserWithTrace
	}
	browsers := options.Browsers
	if browsers == nil {
		browsers = browser.GetInstalledBrowsers()
	}
	safeBrowsers := []string{}
	for _, name := range browsers {
		if !isSelf(name) {
			safeBrowsers = append(safeBrowsers, name)
		}
	}
	e := &Engine{options: options, rulesPath: filepath.Join(options.DataDir, "rules.json"), browsers: safeBrowsers, history: []History{}, stop: make(chan struct{}), done: make(chan struct{})}
	var prefs preferences
	if data, err := os.ReadFile(filepath.Join(options.DataDir, "settings.json")); err == nil {
		if err = json.Unmarshal(data, &prefs); err != nil {
			return nil, fmt.Errorf("read settings: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	e.selectedConfig = prefs.ConfigPath
	if options.ConfigPath != "" {
		absolute, err := filepath.Abs(options.ConfigPath)
		if err != nil {
			return nil, err
		}
		e.selectedConfig = absolute
	}
	fallback := "Safari"
	if runtime.GOOS == "windows" {
		fallback = "Microsoft Edge"
	}
	if runtime.GOOS == "linux" {
		fallback = "Firefox"
	}
	if len(safeBrowsers) > 0 {
		fallback = safeBrowsers[0]
		for _, name := range safeBrowsers {
			if name == "Safari" {
				fallback = name
				break
			}
		}
	}
	e.activeRules = rules.RulesFile{DefaultBrowser: fallback, Rules: []rules.Rule{}}
	// An invalid first config still leaves a usable explicit browser fallback.
	initial, err := e.compile(e.activeRules, "")
	if err != nil {
		return nil, err
	}
	e.vm = initial
	if _, err := os.Stat(e.rulesPath); os.IsNotExist(err) {
		if err = writeJSON(e.rulesPath, e.activeRules); err != nil {
			return nil, err
		}
	}
	e.reloadLocked()
	e.fingerprint = e.filesFingerprint()
	go e.watch()
	return e, nil
}

func (e *Engine) Close() { e.closeOnce.Do(func() { close(e.stop) }); <-e.done }

func (e *Engine) watch() {
	defer close(e.done)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-e.stop:
			return
		case <-ticker.C:
			e.mu.Lock()
			next := e.filesFingerprint()
			if next != e.fingerprint {
				e.reloadLocked()
				e.fingerprint = e.filesFingerprint()
			}
			e.mu.Unlock()
		}
	}
}

// Exact paths only: never register a directory watch or enumerate config parents.
func (e *Engine) filesFingerprint() string {
	hash := sha256.New()
	paths := append([]string{e.rulesPath, e.selectedConfig}, e.dependencies...)
	for _, path := range paths {
		if path == "" {
			continue
		}
		fmt.Fprint(hash, path)
		info, err := os.Stat(path)
		if err != nil {
			fmt.Fprint(hash, err)
			continue
		}
		fmt.Fprintf(hash, "%d:%d:%d", info.ModTime().UnixNano(), info.Size(), info.Mode())
		if info.Mode().IsRegular() && info.Size() <= maxConfigSize {
			data, err := os.ReadFile(path)
			if err == nil {
				hash.Write(data)
			}
		}
	}
	return fmt.Sprintf("%x", hash.Sum(nil))
}

func readRegular(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("configuration must be a regular file: %s", path)
	}
	if info.Size() > maxConfigSize {
		return nil, fmt.Errorf("configuration exceeds %d bytes", maxConfigSize)
	}
	return os.ReadFile(path)
}

func validateRules(rf rules.RulesFile) error {
	if strings.TrimSpace(rf.DefaultBrowser) == "" {
		return errors.New("select a default browser")
	}
	if isSelf(rf.DefaultBrowser) {
		return errors.New("PwrFinicky cannot route to itself")
	}
	for i, r := range rf.Rules {
		if r.Browser == "" || isSelf(r.Browser) {
			return fmt.Errorf("rule %d: select a browser other than PwrFinicky", i+1)
		}
		if len(r.Match) == 0 {
			return fmt.Errorf("rule %d: add at least one match pattern", i+1)
		}
		for _, m := range r.Match {
			if strings.TrimSpace(m) == "" {
				return fmt.Errorf("rule %d: match patterns cannot be empty", i+1)
			}
		}
	}
	return nil
}

func (e *Engine) compile(rf rules.RulesFile, path string) (*config.VM, error) {
	if err := validateRules(rf); err != nil {
		return nil, err
	}
	script, err := rules.ToJSConfigScript(rf, namespace)
	if err != nil {
		return nil, err
	}
	var dependencies []string
	if path != "" {
		if _, err := readRegular(path); err != nil {
			return nil, fmt.Errorf("read config: %w", err)
		}
		result := api.Build(api.BuildOptions{EntryPoints: []string{path}, Bundle: true, Write: false, Format: api.FormatIIFE, GlobalName: namespace, Target: api.ES2015, Platform: api.PlatformBrowser, LogLevel: api.LogLevelSilent, Metafile: true})
		if len(result.Errors) > 0 {
			messages := api.FormatMessages(result.Errors, api.FormatMessagesOptions{Kind: api.ErrorMessage, Color: false})
			return nil, fmt.Errorf("config compilation failed: %s", strings.Join(messages, "\n"))
		}
		if len(result.OutputFiles) != 1 {
			return nil, errors.New("config compiler produced no script")
		}
		script = string(result.OutputFiles[0].Contents)
		var meta struct {
			Inputs map[string]json.RawMessage `json:"inputs"`
		}
		if json.Unmarshal([]byte(result.Metafile), &meta) == nil {
			for input := range meta.Inputs {
				if absolute, err := filepath.Abs(input); err == nil {
					dependencies = append(dependencies, absolute)
				}
			}
		}
	}
	candidate, err := config.NewFromScriptWithTimeout(configAPI, namespace, script, 2*time.Second)
	if err != nil {
		return nil, err
	}
	candidate.SetIsJSConfig(path != "")
	if candidate.GetConfigState() == nil {
		return nil, errors.New("failed to read config metadata")
	}
	e.dependencies = dependencies
	return candidate, nil
}

func (e *Engine) reloadLocked() error {
	started := time.Now()
	diagnostics.Event("config_reload_started", 0)
	defer diagnostics.Event("config_reload_finished", 0)
	data, err := readRegular(e.rulesPath)
	var rf rules.RulesFile
	if err == nil {
		err = json.Unmarshal(data, &rf)
	}
	if err == nil {
		if rf.Rules == nil {
			rf.Rules = []rules.Rule{}
		}
		var candidate *config.VM
		candidate, err = e.compile(rf, e.selectedConfig)
		if err == nil {
			e.vm = candidate
			e.activeRules = rf
			resolver.SetCachedRules(rf)
		}
	}
	if err != nil {
		e.configError = err.Error()
		slog.Warn("Configuration rejected; keeping last working snapshot", "duration_ms", ms(time.Since(started)))
	} else {
		e.configError = ""
		slog.Info("Configuration activated", "duration_ms", ms(time.Since(started)))
	}
	return err
}

func (e *Engine) Reload() Snapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.reloadLocked()
	e.fingerprint = e.filesFingerprint()
	return e.snapshotLocked()
}

func (e *Engine) Snapshot() Snapshot { e.mu.Lock(); defer e.mu.Unlock(); return e.snapshotLocked() }
func (e *Engine) snapshotLocked() Snapshot {
	// Deep-copy mutable slices/maps before releasing the runtime lock.
	snapshot := Snapshot{Version: e.options.Version, Platform: runtime.GOOS, BackendPID: os.Getpid(), ConfigPath: e.selectedConfig, RulesPath: e.rulesPath, ConfigError: e.configError, IsJSConfig: e.vm.IsJSConfig(), ConfigState: e.vm.GetConfigState(), Rules: e.activeRules, Browsers: e.browsers, History: e.history, Capabilities: map[string]bool{"senderApp": runtime.GOOS == "darwin", "windowTitle": false}}
	data, _ := json.Marshal(snapshot)
	var copied Snapshot
	json.Unmarshal(data, &copied)
	return copied
}

func (e *Engine) SaveRules(rf rules.RulesFile) (Snapshot, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if rf.Rules == nil {
		rf.Rules = []rules.Rule{}
	}
	previousDependencies := e.dependencies
	candidate, err := e.compile(rf, e.selectedConfig)
	if err != nil {
		return e.snapshotLocked(), err
	}
	if err = writeJSON(e.rulesPath, rf); err != nil {
		e.dependencies = previousDependencies
		return e.snapshotLocked(), err
	}
	e.vm = candidate
	e.activeRules = rf
	e.configError = ""
	resolver.SetCachedRules(rf)
	e.fingerprint = e.filesFingerprint()
	return e.snapshotLocked(), nil
}

func (e *Engine) SetConfig(path string) (Snapshot, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if path != "" {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return e.snapshotLocked(), err
		}
		path = absolute
	}
	previousDependencies := e.dependencies
	candidate, err := e.compile(e.activeRules, path)
	if err != nil {
		return e.snapshotLocked(), err
	}
	if err = writeJSON(filepath.Join(e.options.DataDir, "settings.json"), preferences{ConfigPath: path}); err != nil {
		e.dependencies = previousDependencies
		return e.snapshotLocked(), err
	}
	e.selectedConfig = path
	e.vm = candidate
	e.configError = ""
	e.fingerprint = e.filesFingerprint()
	return e.snapshotLocked(), nil
}

func isSelf(name string) bool    { return strings.Contains(strings.ToLower(name), "pwrfinicky") }
func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func NormalizeURL(raw string) (string, error) {
	for _, prefix := range []string{"pwrfinicky://open/", "finicky://open/"} {
		if strings.HasPrefix(raw, prefix) {
			decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, prefix))
			if err != nil {
				return "", errors.New("invalid encoded URL")
			}
			raw = string(decoded)
			break
		}
	}
	if len(raw) > 65536 {
		return "", errors.New("URL is too long")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil || parsed.Scheme == "" {
		return "", errors.New("enter an absolute URL including its scheme")
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		if parsed.Host == "" {
			return "", errors.New("URL requires a host")
		}
	}
	if parsed.Scheme == "pwrfinicky" || parsed.Scheme == "finicky" {
		return "", errors.New("unsupported router URL")
	}
	return raw, nil
}

func (e *Engine) Resolve(raw string, opener *resolver.OpenerInfo, launch bool) (Result, error) {
	return e.ResolveReceived(raw, opener, launch, time.Now())
}

func (e *Engine) ResolveReceived(raw string, opener *resolver.OpenerInfo, launch bool, received time.Time) (Result, error) {
	started := received
	trace := diagnostics.BeginAt("pwrfinicky", received)
	trace.Mark("native_receipt_to_dispatch")
	normalized, err := NormalizeURL(raw)
	if err != nil {
		return Result{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	trace.Mark("queue")
	done := make(chan struct{})
	timer := time.AfterFunc(2*time.Second, func() { e.vm.Runtime().Interrupt("routing evaluation timed out"); close(done) })
	resolver.SetCachedRules(e.activeRules)
	cfg, resolveErr := resolver.ResolveURLWithTrace(e.vm, normalized, opener, false, trace)
	if !timer.Stop() {
		<-done
	}
	e.vm.Runtime().ClearInterrupt()
	resolveMS := ms(time.Since(started))
	var launchErr error
	if resolveErr == nil && isSelf(cfg.Name) {
		resolveErr = errors.New("routing back to PwrFinicky would create a loop")
	}
	launchStart := time.Now()
	if launch && resolveErr == nil {
		launchErr = e.options.Launch(*cfg, e.options.DryRun, false, trace)
	}
	launchMS := ms(time.Since(launchStart))
	result := Result{URL: cfg.URL, Browser: cfg.Name, Profile: cfg.Profile, Args: cfg.Args, DurationMS: ms(time.Since(started)), LaunchMS: launchMS}
	if cfg.OpenInBackground != nil {
		result.OpenInBackground = *cfg.OpenInBackground
	}
	if result.Args == nil {
		result.Args = []string{}
	}
	if resolveErr != nil {
		result.Error = resolveErr.Error()
	}
	if launchErr != nil {
		result.Error = launchErr.Error()
	}
	source := "manual"
	if opener != nil && opener.Name != "" {
		source = opener.Name
	}
	item := History{ID: fmt.Sprint(trace.ID), Time: time.Now().UTC().Format(time.RFC3339Nano), URL: normalized, Browser: result.Browser, Profile: result.Profile, DurationMS: result.DurationMS, ResolveMS: resolveMS, LaunchMS: launchMS, DryRun: !launch || e.options.DryRun, Success: result.Error == "", Error: result.Error, Source: source}
	e.history = append([]History{item}, e.history...)
	if len(e.history) > 200 {
		e.history = e.history[:200]
	}
	trace.Finish(!launch || e.options.DryRun, resolveErr != nil, launchErr != nil)
	slog.Info("Link handled", "dispatch_id", trace.ID, "duration_ms", result.DurationMS, "resolve_ms", resolveMS, "launch_ms", launchMS, "success", item.Success, "dry_run", item.DryRun)
	return result, nil
}

// writeJSON uses a same-directory temporary file and only publishes on rename.
func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".pwrfinicky-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(append(data, '\n'))
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temp.Name(), path)
}
