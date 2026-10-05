package config

import (
	"finicky/util"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/evanw/esbuild/pkg/api"
	"github.com/fsnotify/fsnotify"
	babel "github.com/jvatic/goja-babel"
)

// ConfigFileWatcher handles watching configuration files for changes
type ConfigFileWatcher struct {
	watcher            *fsnotify.Watcher
	customConfigPath   string
	namespace          string
	configChangeNotify chan struct{}

	// Cache manager
	cache       *ConfigCache
	bundleMu    sync.Mutex
	cacheDirty  atomic.Bool
	done        chan struct{}
	initialPath string
	initialInfo os.FileInfo
	closed      bool
	closeOnce   sync.Once
	eventWake   chan struct{}
	eventsDone  chan struct{}
	rearm       atomic.Bool

	// Debounce rapid file-change events (e.g. editors that write twice)
	debounceMu       sync.Mutex
	debounceTimer    *time.Timer
	debounceSequence uint64
}

// NewConfigFileWatcher creates a new file watcher for configuration files
func NewConfigFileWatcher(customConfigPath string, namespace string, configChangeNotify chan struct{}) (*ConfigFileWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	cfw := &ConfigFileWatcher{
		watcher:            watcher,
		customConfigPath:   customConfigPath,
		namespace:          namespace,
		configChangeNotify: configChangeNotify,
		cache:              NewConfigCache(),
		done:               make(chan struct{}),
	}

	// Register an existing file before returning so immediate saves are observed.
	if path, err := cfw.GetConfigPath(false); err == nil {
		cfw.initialPath = path
		cfw.initialInfo, _ = os.Stat(path)
		if err := cfw.watchConfigFile(path); err != nil {
			slog.Warn("Failed to watch config file", "path", path, "error", err)
		}
	}
	go func() {
		defer close(cfw.done)
		if err := cfw.StartWatching(); err != nil {
			cfw.debounceMu.Lock()
			closed := cfw.closed
			cfw.debounceMu.Unlock()
			if !closed {
				slog.Error("Configuration watcher stopped", "error", err)
			}
		}
	}()

	return cfw, nil
}

// TearDown closes the file watcher
func (cfw *ConfigFileWatcher) TearDown() {
	cfw.closeOnce.Do(func() {
		cfw.debounceMu.Lock()
		cfw.closed = true
		if cfw.debounceTimer != nil {
			cfw.debounceTimer.Stop()
		}
		cfw.debounceMu.Unlock()
		cfw.watcher.Close()
	})
	if cfw.done != nil {
		<-cfw.done
	}
}

// GetConfigPaths returns a list of potential configuration file paths
func (cfw *ConfigFileWatcher) GetConfigPaths() []string {
	var configPaths []string

	homeDir, err := util.UserHomeDir()
	if err != nil {
		slog.Error("Failed to get user home directory", "error", err)
		return configPaths
	}

	if cfw.customConfigPath != "" {
		configPaths = append(configPaths, cfw.customConfigPath)
	} else {
		configPaths = append(configPaths,
			"~/.finicky.js",
			"~/.finicky.ts",
			"~/.config/finicky.js",
			"~/.config/finicky.ts",
			"~/.config/finicky/finicky.js",
			"~/.config/finicky/finicky.ts",
		)
	}

	for i, path := range configPaths {
		path = os.ExpandEnv(path)
		// Expand only the home prefix. A tilde inside a filename (including
		// Windows short paths such as RUNNER~1) is part of the actual path.
		if path == "~" {
			path = homeDir
		} else if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
			path = filepath.Join(homeDir, path[2:])
		}
		configPaths[i] = filepath.Clean(path)
	}

	return configPaths
}

// GetConfigPath returns the path to an existing configuration file
func (cfw *ConfigFileWatcher) GetConfigPath(log bool) (string, error) {
	configPaths := cfw.GetConfigPaths()

	for _, path := range configPaths {
		if _, err := os.Stat(path); err == nil {
			// Resolve symlinks to get the actual file path
			resolvedPath, err := resolveSymlink(path)
			if err != nil {
				slog.Warn("Failed to resolve symlink, using original path", "original", path, "error", err)
				resolvedPath = path
			}

			if log {
				if resolvedPath != path {
					slog.Info("Using config file", "path", resolvedPath)
				} else {
					slog.Info("Using config file", "path", path)
				}
			}
			return resolvedPath, nil
		}
	}
	if cfw.customConfigPath != "" {
		return "", fmt.Errorf("no config file found at %s", cfw.customConfigPath)
	}
	return "", fmt.Errorf("no config file found in any of these locations: %s", strings.Join(configPaths, ", "))
}

func (cfw *ConfigFileWatcher) BundleConfig() (string, string, error) {
	cfw.bundleMu.Lock()
	defer cfw.bundleMu.Unlock()
	if cfw.cacheDirty.Swap(false) {
		cfw.cache.Clear()
	}
	configPath, err := cfw.GetConfigPath(true)

	if configPath == "" || err != nil {
		return "", "", err
	}

	// Check if we can use cached bundle
	if bundlePath, cacheHit := cfw.cache.GetCachedBundle(configPath); cacheHit {
		return bundlePath, configPath, nil
	}

	// Apply babel transformation
	transformedPath, err := cfw.babelTransform(configPath)
	if err != nil {
		return "", configPath, err
	}

	slog.Debug("Bundling config")

	// Use a deterministic filename to help with caching
	bundlePath := GetBundlePath(transformedPath)

	result := api.Build(api.BuildOptions{
		EntryPoints: []string{transformedPath},
		Outfile:     bundlePath,
		Bundle:      true,
		Write:       true,
		LogLevel:    api.LogLevelError,
		Platform:    api.PlatformNeutral,
		Target:      api.ES2015,
		Format:      api.FormatIIFE,
		GlobalName:  cfw.namespace,
		Loader: map[string]api.Loader{
			".ts.symlink": api.LoaderTS,
			".js.symlink": api.LoaderJS,
		},
	})

	if len(result.Errors) > 0 {
		var errorTexts []string
		for _, err := range result.Errors {
			errorTexts = append(errorTexts, err.Text)
		}
		return "", configPath, fmt.Errorf("build errors: %s", strings.Join(errorTexts, ", "))
	}

	// Update cache
	originalConfigPath, err := cfw.GetConfigPath(false)
	if err == nil {
		cfw.cache.UpdateCache(originalConfigPath, bundlePath)
	}

	return bundlePath, configPath, nil
}

func (cfw *ConfigFileWatcher) babelTransform(configPath string) (string, error) {
	startTime := time.Now()
	slog.Debug("Transforming config with babel")

	// Check if we need to transform (only if it's a .js or .mjs file)
	ext := filepath.Ext(configPath)
	if ext != ".js" && ext != ".mjs" {
		slog.Debug("Skipping babel transform for non-JS file", "path", configPath)
		return configPath, nil
	}

	configBytes, err := os.ReadFile(configPath)
	if err != nil {
		return "", fmt.Errorf("error reading config file: %w", err)
	}
	configString := string(configBytes)

	babel.Init(1) // Setup transformers (can be any number > 0)
	res, err := babel.Transform(strings.NewReader(configString), map[string]interface{}{
		"plugins": []string{
			"transform-named-capturing-groups-regex",
		},
	})

	if err != nil {
		return "", err
	}

	resBytes, err := io.ReadAll(res)
	if err != nil {
		return "", err
	}
	resString := string(resBytes)

	// Get a deterministic path for the transformed file
	transformedPath := GetTransformedPath(configString)

	// Check if transformed file already exists
	if _, err := os.Stat(transformedPath); err == nil {
		slog.Debug("Using existing transformed file", "path", transformedPath)
		return transformedPath, nil
	}

	// Write to the persistent location
	err = os.WriteFile(transformedPath, []byte(resString), 0644)
	if err != nil {
		return "", fmt.Errorf("error writing to transform file: %w", err)
	}

	slog.Debug("Saved babel output", "path", transformedPath)
	slog.Debug("Babel transform complete", "duration", fmt.Sprintf("%.2fms", float64(time.Since(startTime).Microseconds())/1000))

	// Clean up old transformed files
	CleanupOldFiles("transform", transformedPath)

	return transformedPath, nil
}

// Config discovery may find a directory at a candidate path. Never register
// a directory with fsnotify: kqueue would open unrelated immediate children.
func (cfw *ConfigFileWatcher) watchConfigFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("config path is not a regular file: %s", path)
	}
	return cfw.watcher.Add(path)
}

func (cfw *ConfigFileWatcher) StartWatching() error {
	// Windows delivers events and executes Add/Remove on the same backend
	// thread. Always drain its channels independently: calling Remove from
	// the sole event consumer can deadlock behind a pending unbuffered event.
	cfw.eventWake = make(chan struct{}, 1)
	cfw.eventsDone = make(chan struct{})
	go cfw.consumeEvents()
	defer func() { cfw.watcher.Close(); <-cfw.eventsDone }()
	poll := time.NewTicker(500 * time.Millisecond)
	defer poll.Stop()
	previousPath, previousInfo := cfw.initialPath, cfw.initialInfo
	// Preserve the constructor's missing state. Re-snapshotting here would
	// swallow a creation between construction and this goroutine starting.
	for {
		cfw.debounceMu.Lock()
		closed := cfw.closed
		cfw.debounceMu.Unlock()
		if closed {
			return nil
		}
		configPath, err := cfw.GetConfigPath(false)

		// Drop stale inode watches before switching discovery paths or polling.
		for _, watched := range cfw.watcher.WatchList() {
			if err != nil || watched != configPath {
				cfw.watcher.Remove(watched)
			}
		}
		if err != nil {
			if previousInfo != nil {
				cfw.handleConfigFileEvent(fsnotify.Event{Name: previousPath, Op: fsnotify.Remove})
			}
			previousPath = ""
			previousInfo = nil
			configPath, err = cfw.waitForConfig()
			if err != nil {
				return err
			}

			if err := cfw.handleConfigFileEvent(fsnotify.Event{Name: configPath, Op: fsnotify.Create}); err != nil {
				return err
			}

		} else {
			info, statErr := os.Stat(configPath)
			if statErr != nil {
				continue
			}
			// The inode changes during atomic saves; timestamps/size cover ordinary
			// writes if the platform fails to deliver a write event.
			if cfw.rearm.Swap(false) || previousInfo == nil || previousPath != configPath || !os.SameFile(previousInfo, info) ||
				!previousInfo.ModTime().Equal(info.ModTime()) || previousInfo.Size() != info.Size() {
				cfw.watcher.Remove(configPath)
				cfw.handleConfigFileEvent(fsnotify.Event{Name: configPath, Op: fsnotify.Write})
			}
			previousPath, previousInfo = configPath, info
			if err := cfw.watchConfigFile(configPath); err != nil {
				slog.Warn("Failed to watch config file; using polling", "path", configPath, "error", err)
			}
			select {
			case <-cfw.eventWake:
			case <-cfw.eventsDone:
				return nil
			case <-poll.C:
			}

		}
	}
	// Unreachable - infinite loop above. Added for completeness only.
	// return nil
}

func (cfw *ConfigFileWatcher) consumeEvents() {
	defer close(cfw.eventsDone)
	for {
		select {
		case event, ok := <-cfw.watcher.Events:
			if !ok {
				return
			}
			if event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename) {
				cfw.rearm.Store(true)
			}
			cfw.handleConfigFileEvent(event)
		case err, ok := <-cfw.watcher.Errors:
			if !ok {
				return
			}
			slog.Error("Configuration watcher error", "error", err)
		}
		select {
		case cfw.eventWake <- struct{}{}:
		default:
		}
	}
}

// handleConfigFileEvent invalidates bundles for every content/identity change.
// Removal is recoverable: continue discovery and retain the active VM.
func (cfw *ConfigFileWatcher) handleConfigFileEvent(event fsnotify.Event) error {
	if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) == 0 {
		return nil
	}
	cfw.cacheDirty.Store(true)
	cfw.debounceMu.Lock()
	defer cfw.debounceMu.Unlock()
	if cfw.closed {
		return nil
	}
	if cfw.debounceTimer != nil {
		cfw.debounceTimer.Stop()
	}
	cfw.debounceSequence++
	sequence := cfw.debounceSequence
	cfw.debounceTimer = time.AfterFunc(500*time.Millisecond, func() {
		cfw.debounceMu.Lock()
		defer cfw.debounceMu.Unlock()
		if cfw.closed || sequence != cfw.debounceSequence {
			return
		}
		select {
		case cfw.configChangeNotify <- struct{}{}:
		default:
		}
	})
	return nil
}

// resolveSymlink resolves a symlink to its target file path
// If the path is not a symlink, it returns the original path
func resolveSymlink(path string) (string, error) {
	fileInfo, err := os.Lstat(path)
	if err != nil {
		return path, err
	}

	// Check if it's a symlink
	if fileInfo.Mode()&os.ModeSymlink != 0 {
		resolvedPath, err := filepath.EvalSymlinks(path)
		if err != nil {
			return path, fmt.Errorf("failed to resolve symlink %s: %w", path, err)
		}
		slog.Debug("Resolved symlink", "original", path, "resolved", resolvedPath)
		return resolvedPath, nil
	}

	return path, nil
}
