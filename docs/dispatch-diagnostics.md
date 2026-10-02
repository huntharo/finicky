# Investigating intermittent dispatch delays

This change records evidence; it does not change URL routing, Accessibility queries,
window activation, timeouts, or browser launch behavior.

## Architecture and measured evidence

Finicky is Go with Cocoa callbacks via cgo. JavaScript config runs synchronously in
Goja. The settings UI is Svelte in WKWebView; there is no Electron runtime.

The URL path is:

1. Cocoa receives a GetURL AppleEvent, file-open callback, or browsing user activity.
2. For AppleEvents, the main thread resolves the sender and asks Accessibility for
   its focused window and title. The title can be used by config match functions.
3. Go decodes `finicky://open/`, then sends to an unbuffered channel. The main
   event goroutine serializes dispatch with config reloads and window requests.
4. With a VM, the resolver checks known shortener domains and may make HEAD then
   GET requests, each with a 750 ms timeout. It prepares cached JSON handlers,
   invokes the config API, and decodes the result. The API validates config,
   applies rewrites, and checks handlers in order; wildcard, regex `.test`, and
   arbitrary matcher functions all run synchronously inside this JS stage.
5. The launcher resolves profile arguments (including browser profile files),
   starts `open`, reads its pipes, and waits for it to exit. This is a handoff;
   Finicky cannot measure when the browser finishes starting or renders a page.

On startup, config discovery, cached bundling/Babel, VM creation, and logging
setup precede Cocoa event handling. The duplicate-instance scan can wait up to
one second if another matching-bundle process does not exit. `keepRunning`
defaults to true; when false, the app schedules exit after dispatch. Exit also
checks update settings. Startup and sleep/wake lifecycle records distinguish
these paths from requests handled by an existing process.

Evidence collected on macOS arm64, October 2, 2026:

| Scenario | Evidence | Interpretation |
| --- | --- | --- |
| Existing installed v4.2.2 log | Two dispatches measured 69.00 and 235.93 ms; two window-show messages | Timer began after dequeue. Neither captures the reported stall or explains the window. This log is from a different version than the source base. |
| Isolated app, three direct `osascript` URL events | Approximately 1501–1520 ms inside native Accessibility; ordinary JS evaluation 2.6–5.9 ms | Demonstrated pre-enqueue delay for this sender. Does not prove the user's original requests stall here. |
| Split Accessibility timing for `osascript` | Focus query 1511.44 ms, result `-25204` (`kAXErrorCannotComplete`); no title query | Focused-window IPC explains this reproduced delay. |
| Same running app, URL sent with `open -a` | 2.49 ms total, no AX query; native log says sender process was not found | Fast path differs at sender lookup, not in JS/regex evaluation. |
| After 93 seconds idle, direct `osascript` event | 1501.18 ms focused-window query, total 1504.88 ms, `path=idle` | Idle marker and the same sender-specific stall reproduced. |
| Same sender, synthetic 650 ms matcher | JS measured 656 ms, total 2159 ms including Accessibility | Independent stages expose the injected rule delay. |
| Reopen the isolated app without a URL | `reopen(value=0)` → `window_reason_reopen` → setup → `window_ordered_front` | Reopen demonstrably invokes the settings window and activates the app. Whether the user's URL launch also causes reopen requires their trace. |
| Fake `open` executable, 600 ms wait and failing exit | Delay attributed to `open_wait`, failure recorded; URL arguments and stderr omitted | Browser handoff timing and log privacy tested without launching a real browser. |

Hypotheses still requiring the user's trace: Accessibility IPC for their sender;
Launch Services/reopen behavior before native receipt; cold config startup;
serialized config reload; short-URL network fallback; expensive config/regex;
profile lookup; `open`/browser startup; and App Nap or wake scheduling. No
performance or window suppression fix is included.

## Reading the diagnostics

`Dispatch timing` is emitted automatically for completed dispatches taking at
least 500 ms. Set `FINICKY_DIAGNOSTICS=1` before starting the process to also
record fast dispatches. Correlate by `pid` and `dispatch_id`; IDs restart in each
process. `path=first` means the first URL in this process, not necessarily a cold
OS launch. `warm` means a subsequent receipt within a minute; `idle` means at
least a minute since the previous receipt. `idle_ms` measures that interval.

`go_age_ms` starts during Go package initialization, not at the user's click or
kernel process creation. Startup timing records watcher and config setup.
Lifecycle records cover launch, duplicate scan/count, activation, system
sleep/wake, reload, show reason, setup and ordering the window front. Their
`latest_dispatch_id` is context, not a causal link. Repeated launch notifications
are preserved as observed. Window-show return may precede asynchronous display;
use `window_ordered_front` to locate the actual ordering/activation request.

All stage values are milliseconds since the previous boundary:

| Stage | Work measured |
| --- | --- |
| `sender_lookup`, `sender_metadata` | Native sender/frontmost-app lookup, sender metadata |
| `accessibility_focus`, `accessibility_title`, `accessibility_cleanup` | Focus query, optional title query, cleanup; `native_results` contains numeric AX result codes |
| `decode`, `queue` | Go input copying/protocol decoding, then channel wait until dequeue |
| `resolve_setup`, `short_url` | Resolver setup, then shortener detection/network |
| `rules_prepare`, `javascript`, `result_decode` | JS inputs/cached JSON handlers, config API/matchers/rewrites, output decoding |
| `resolve_result` | Resolution bookkeeping/fallback/error reporting |
| `browser_prepare`, `open_start`, `open_wait`, `handoff_result` | Profile/arguments, process start, pipes/process exit, result reporting |

Stages not reached are absent, including `open_start`/`open_wait` in dry run.
Timings include normal logging/scheduling at their boundaries. A standalone
recorder benchmark measured about 2.4 µs per fast request; it excludes cgo,
resolver/launcher work and emitted logs. There are no per-matcher timers or
additional filesystem, browser-state or network probes. A long JS stage warrants
profiling that config before changing regex/rule handling.

New timing records contain no URL, title, config text, args or raw errors.
Routine receipt, redirect, command and opener-title logs no longer print full
URLs or browser command lines. Browser stderr/stdout are logged by byte count.
Dispatch error logs omit raw config errors that may embed URLs; the Test URL UI
still returns the error. Config-generated `console.log`/errors, config paths and
profile names can still contain private information. Share filtered diagnostic
records, not entire legacy/request logs.

## Build and reproduce without replacing the installed app

Requirements: Apple Silicon macOS, Go, Xcode command-line tools, Node/npm, Python 3.
From this checkout:

```sh
npm ci --prefix packages/config-api
npm ci --prefix packages/finicky-ui
bash scripts/build-dispatch-diagnostics.sh
```

The helper uses `BUILD_TARGET_ARCH=arm64` so the regular build script does not
install into `/Applications`. It creates an artifact-only Go overlay removing
startup default-browser registration and disabling the Go association setter,
and gives the copied app a distinct bundle ID with URL, document and user-activity
handlers removed. This prevents changing associations and keeps the native
same-bundle duplicate scan away from the installed Finicky. Production sources
retain their behavior. **Do not run the ordinary build artifact** alongside the
installed app: its startup changes associations and terminates other instances.

Start the isolated executable in a terminal (the generated rules path is absent):

```sh
FINICKY_DIAGNOSTICS=1 \
  apps/finicky/build/Finicky-Dispatch-Diagnostics.app/Contents/MacOS/Finicky \
  --config "$PWD/apps/finicky/build/dispatch-diagnostics/test-config.ts" \
  --rules "$PWD/apps/finicky/build/dispatch-diagnostics/no-rules.json" \
  --dry-run > apps/finicky/build/dispatch-diagnostics/runtime.log 2>&1
```

In a second terminal, send explicit events to this app, without making it default:

```sh
osascript -e 'tell application "'"$PWD"'/apps/finicky/build/Finicky-Dispatch-Diagnostics.app" to open location "https://example.com/fast"'
osascript -e 'tell application "'"$PWD"'/apps/finicky/build/Finicky-Dispatch-Diagnostics.app" to open location "https://example.com/slow"'
# Repeat the fast event, then repeat after at least a minute idle.
# To inspect the explicit reopen/window path:
open -a "$PWD/apps/finicky/build/Finicky-Dispatch-Diagnostics.app"
```

Quit only the isolated app, or Ctrl-C its terminal. Repeat starting the executable
and sending the first event to compare process startup with warm dispatch. Dry
run skips real browser handoff; remove it only when intentionally testing browser
opening. To test your config, supply an explicit copy and isolated JSON rules;
watch out for config functions that print or transmit private input themselves.
The isolated identity will have different Accessibility permissions from the
installed app, so sender-specific results require confirmation in the intended
environment.

For the original symptom, record source app/action, whether Finicky/browser was
already running, time since last request or wake, whether a window appeared, and
the click time to millisecond precision if possible. Compare click time with
native receipt inferred from `total_ms` and the summary timestamp. A gap before
receipt is outside the dispatch timer. For a stall still in progress, obtain a
short `sample <diagnostic-pid> 3 -file <local-file>` and inspect its main-thread
stack locally; a completed summary alone cannot diagnose a permanently hung
callback. Samples may include private data. Do not terminate the installed app
or change associations to reproduce without explicitly choosing that action.

Extract only the timing/lifecycle records for sharing:

```sh
# -R/fromjson? skips native stderr lines while keeping JSON records.
jq -Rc 'fromjson? | select(.msg == "Dispatch timing" or .msg == "Startup timing" or .msg == "App lifecycle")' \
  apps/finicky/build/dispatch-diagnostics/runtime.log
```

Disk logging follows existing `logRequests` settings;
stdout capture above works without enabling request logs.
