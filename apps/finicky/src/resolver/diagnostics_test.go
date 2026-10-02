package resolver_test

import (
	"bytes"
	"encoding/json"
	"finicky/diagnostics"
	"finicky/resolver"
	"log/slog"
	"strings"
	"testing"
)

func TestResolverTimingAndURLPrivacy(t *testing.T) {
	vm := jsVM(t, `({ defaultBrowser: "Safari", handlers: [{
		match: function(url) { var start = Date.now(); while (Date.now() - start < 100) {} return false; },
		browser: "Safari"
	}] })`)
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	t.Setenv("FINICKY_DIAGNOSTICS", "1")
	trace := diagnostics.Begin("apple_event")
	result, err := resolver.ResolveURLWithTrace(vm, "https://example.com/private?token=SECRET", &resolver.OpenerInfo{WindowTitle: "SECRET_TITLE"}, false, trace)
	trace.Finish(true, err != nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.URL, "SECRET") {
		t.Fatal("routing must preserve the actual URL")
	}
	if strings.Contains(output.String(), "SECRET") {
		t.Fatalf("private input leaked: %s", output.String())
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
		if stages["javascript"].(float64) < 90 {
			t.Fatalf("matcher delay missing from JS stage: %v", stages)
		}
		if stages["short_url"].(float64) > 90 {
			t.Fatalf("matcher delay misattributed to network: %v", stages)
		}
	}
	if !found {
		t.Fatal("missing timing summary")
	}
}
