//go:build darwin

package browser

import (
	"bytes"
	"encoding/json"
	"finicky/diagnostics"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLaunchTimingAndURLPrivacy(t *testing.T) {
	// A fake open exercises process handoff without opening any application.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "open"), []byte("#!/bin/sh\n/bin/sleep 0.6\necho \"$*\" >&2\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("FINICKY_DIAGNOSTICS", "")
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	trace := diagnostics.Begin("file")
	err := LaunchBrowserWithTrace(BrowserConfig{Name: "Safari", AppType: "bundleId", URL: "https://example.com/private?token=SECRET", Args: []string{"https://example.com/ARG_SECRET"}}, false, false, trace)
	trace.Finish(false, false, err != nil)
	if err == nil {
		t.Fatal("expected fake open to fail")
	}
	if strings.Contains(output.String(), "SECRET") || strings.Contains(output.String(), "https://") {
		t.Fatalf("URL leaked: %s", output.String())
	}
	found := false
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		var record map[string]interface{}
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record["msg"] != "Dispatch timing" {
			continue
		}
		found = true
		stages := record["stages_ms"].(map[string]interface{})
		if stages["open_wait"].(float64) < 550 || record["launch_failed"] != true {
			t.Fatalf("bad handoff attribution: %v", record)
		}
	}
	if !found {
		t.Fatal("missing automatic slow summary")
	}
}
