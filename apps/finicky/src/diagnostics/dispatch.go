// Package diagnostics records dispatch boundaries without retaining URL or opener data.
package diagnostics

import (
	"log/slog"
	"os"
	"sync"
	"time"
)

const SlowThreshold = 500 * time.Millisecond
const IdleThreshold = time.Minute

var processStart = time.Now()
var state struct {
	sync.Mutex
	id   uint64
	last time.Time
}

// Trace is passed along with a dispatch; Mark measures time since the last boundary.
// All labels are fixed in code. Do not pass URLs, config strings or error text here.
type Trace struct {
	ID      uint64
	Source  string
	Path    string
	Idle    time.Duration
	started time.Time
	last    time.Time
	stages  map[string]float64
	values  map[string]int
}

func Begin(source string) *Trace {
	now := time.Now()
	state.Lock()
	defer state.Unlock()
	path := "warm"
	var idle time.Duration
	if state.last.IsZero() {
		path = "first"
	} else {
		idle = now.Sub(state.last)
		if idle >= IdleThreshold {
			path = "idle"
		}
	}
	state.id++
	state.last = now
	return &Trace{ID: state.id, Source: source, Path: path, Idle: idle, started: now, last: now, stages: make(map[string]float64, 16), values: make(map[string]int)}
}

func milliseconds(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func AgeMS() float64 { return milliseconds(time.Since(processStart)) }

func (t *Trace) Mark(stage string) {
	if t == nil {
		return
	}
	now := time.Now()
	t.stages[stage] += milliseconds(now.Sub(t.last))
	t.last = now
}

func (t *Trace) Value(key string, value int) {
	if t != nil {
		t.values[key] = value
	}
}

// Finish emits a single record for a slow dispatch, or all dispatches when requested.
// Completion means the open process has returned, not that the browser rendered a page.
func (t *Trace) Finish(dryRun, resolveFailed, launchFailed bool) {
	if t == nil {
		return
	}
	elapsed := time.Since(t.started)
	if elapsed < SlowThreshold && os.Getenv("FINICKY_DIAGNOSTICS") != "1" {
		return
	}
	slog.Info("Dispatch timing", "pid", os.Getpid(), "dispatch_id", t.ID,
		"source", t.Source, "path", t.Path, "idle_ms", milliseconds(t.Idle),
		"go_age_ms", AgeMS(), "total_ms", milliseconds(elapsed), "slow", elapsed >= SlowThreshold,
		"stages_ms", t.stages, "native_results", t.values, "dry_run", dryRun, "resolve_failed", resolveFailed, "launch_failed", launchFailed)
}

// Event records infrequent native lifecycle events. latest_dispatch_id is context,
// not proof that a dispatch caused an activation or window request.
func Event(event string, value int) {
	state.Lock()
	id := state.id
	state.Unlock()
	slog.Info("App lifecycle", "pid", os.Getpid(), "go_age_ms", AgeMS(),
		"latest_dispatch_id", id, "event", event, "value", value)
}
