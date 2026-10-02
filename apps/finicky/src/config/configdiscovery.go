package config

import (
	"fmt"
	"log/slog"
	"time"
)

// waitForConfig checks only the configured candidate paths until one exists.
// Do not watch their parent directories: on macOS, fsnotify's kqueue backend
// opens every immediate child (including symlink targets). Watching the home
// directory can therefore request access to unrelated protected folders.
func (cfw *ConfigFileWatcher) waitForConfig() (string, error) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	slog.Debug("Waiting for config file", "paths", cfw.GetConfigPaths())
	for {
		// Check immediately as well, so a file created between the initial
		// lookup and entering discovery is not missed.
		if path, err := cfw.GetConfigPath(false); err == nil {
			return path, nil
		}
		select {
		case <-ticker.C:
		case _, ok := <-cfw.watcher.Events:
			if !ok {
				return "", fmt.Errorf("watcher closed")
			}
		case err, ok := <-cfw.watcher.Errors:
			if !ok {
				return "", fmt.Errorf("watcher closed")
			}
			slog.Debug("error:", "error", err)
		}
	}
}
