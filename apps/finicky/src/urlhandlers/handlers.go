// Package urlhandlers manages explicit, reversible developer URL associations.
// It deliberately has no macOS dependencies so the workflow can be tested without
// registering applications or changing a developer's actual defaults.
package urlhandlers

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

var Schemes = []string{"http", "https", "finicky"}

type Registry interface {
	Handler(scheme string) (string, error)
	Register(app string) error
	SetHandler(scheme, app string) error
}

type Snapshot struct {
	App      string            `json:"developmentApp"`
	Previous map[string]string `json:"previous"`
}

// Switch saves every previous application path before any registry mutation.
// A partial failure leaves the snapshot available for Restore, including when a
// setter changes the association but reports a failure afterwards.
func Switch(r Registry, app, statePath string) error {
	previous := make(map[string]string)
	for _, scheme := range Schemes {
		handler, err := r.Handler(scheme)
		if err != nil || handler == "" {
			return fmt.Errorf("cannot preserve %s handler: %v (no changes made)", scheme, err)
		}
		if !filepath.IsAbs(handler) {
			return fmt.Errorf("invalid original %s application path", scheme)
		}
		if handler == app {
			return fmt.Errorf("%s already points to development app; cannot capture original handler", scheme)
		}
		previous[scheme] = handler
	}
	snapshot := Snapshot{App: app, Previous: previous}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.OpenFile(statePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("create restore state (restore existing state before switching again): %w", err)
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(statePath)
		return fmt.Errorf("save restore state: %w", err)
	}
	if err := r.Register(app); err != nil {
		return fmt.Errorf("register development app: %w; restore with saved state", err)
	}
	for _, scheme := range Schemes {
		current, err := r.Handler(scheme)
		if err != nil {
			return err
		}
		if current != previous[scheme] {
			return fmt.Errorf("%s handler changed during switch; restore with saved state %s", scheme, statePath)
		}
		if err := setAndVerify(r, scheme, app); err != nil {
			return fmt.Errorf("%w; restore with saved state %s", err, statePath)
		}
	}
	return nil
}

// Restore refuses to overwrite associations changed by another app since Switch.
// Keep the snapshot on any failure, making partial restores safe to retry.
func Restore(r Registry, app, statePath string) error {
	data, err := os.ReadFile(statePath)
	if err != nil {
		return err
	}
	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return err
	}
	if snapshot.App != app {
		return fmt.Errorf("restore state belongs to a different development app: %s", snapshot.App)
	}
	for _, scheme := range Schemes {
		previous := snapshot.Previous[scheme]
		if !filepath.IsAbs(previous) {
			return fmt.Errorf("invalid saved %s application path", scheme)
		}
		current, err := r.Handler(scheme)
		if err != nil {
			return err
		}
		if current != app && current != previous {
			return fmt.Errorf("%s handler changed externally to %s; refusing to overwrite it", scheme, current)
		}
	}
	for _, scheme := range Schemes {
		current, err := r.Handler(scheme)
		if err != nil {
			return err
		}
		if current == snapshot.Previous[scheme] {
			continue
		}
		if current != app {
			return fmt.Errorf("%s handler changed during restore; refusing to overwrite it", scheme)
		}
		if err := setAndVerify(r, scheme, snapshot.Previous[scheme]); err != nil {
			return err
		}
	}
	return os.Remove(statePath)
}

func setAndVerify(r Registry, scheme, app string) error {
	if err := r.SetHandler(scheme, app); err != nil {
		return fmt.Errorf("set %s handler: %w", scheme, err)
	}
	actual, err := r.Handler(scheme)
	if err != nil {
		return err
	}
	if actual != app {
		return fmt.Errorf("%s handler verification failed: expected %s, got %s", scheme, app, actual)
	}
	return nil
}
