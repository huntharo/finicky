package diagnostics

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestDispatchSummarySelection(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	t.Setenv("FINICKY_DIAGNOSTICS", "")

	fast := Begin("apple_event")
	fast.Mark("queue")
	fast.Finish(false, false, false)
	if output.Len() != 0 {
		t.Fatal("fast requests should not produce routine timing summaries")
	}

	slow := Begin("apple_event")
	slow.started = time.Now().Add(-600 * time.Millisecond)
	slow.last = slow.started
	slow.Mark("accessibility_focus")
	slow.Finish(false, false, false)
	var record map[string]interface{}
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record["slow"] != true || record["total_ms"].(float64) < 600 {
		t.Fatalf("bad slow summary: %v", record)
	}
	stages := record["stages_ms"].(map[string]interface{})
	if stages["accessibility_focus"].(float64) < 600 {
		t.Fatalf("delay attributed to wrong stage: %v", stages)
	}

	output.Reset()
	t.Setenv("FINICKY_DIAGNOSTICS", "1")
	Begin("file").Finish(true, true, true)
	if !strings.Contains(output.String(), `"dry_run":true`) || !strings.Contains(output.String(), `"resolve_failed":true`) {
		t.Fatal(output.String())
	}
}

func TestDispatchPathClassification(t *testing.T) {
	state.Lock()
	state.last = time.Time{}
	state.Unlock()
	if got := Begin("apple_event").Path; got != "first" {
		t.Fatal(got)
	}
	if got := Begin("apple_event").Path; got != "warm" {
		t.Fatal(got)
	}
	state.Lock()
	state.last = time.Now().Add(-2 * IdleThreshold)
	state.Unlock()
	trace := Begin("apple_event")
	if trace.Path != "idle" || trace.Idle < IdleThreshold {
		t.Fatalf("bad idle classification: %+v", trace)
	}
}

func BenchmarkFastDispatch(b *testing.B) {
	b.Setenv("FINICKY_DIAGNOSTICS", "")
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		trace := Begin("apple_event")
		for _, stage := range []string{"sender_lookup", "sender_metadata", "accessibility_focus", "accessibility_title", "accessibility_cleanup", "decode", "queue", "resolve_setup", "short_url", "rules_prepare", "javascript", "result_decode", "browser_prepare", "open_start", "open_wait"} {
			trace.Mark(stage)
		}
		trace.Value("ax_focus_result", 0)
		trace.Value("ax_title_result", 0)
		trace.Finish(false, false, false)
	}
}
