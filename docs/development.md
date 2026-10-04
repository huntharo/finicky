# Developing Finicky in a worktree

Start with the official [Building Finicky from source](https://github.com/johnste/finicky/wiki/Building-Finicky-from-source) instructions linked from the README: install dependencies with `./scripts/install.sh`, then build with `./scripts/build.sh` from the repository base folder. The wiki specifies Node 22 and Go 1.23.4; the current `apps/finicky/src/go.mod` and macOS CI require Go 1.24 or newer. Use Node 22 and the current Go requirement for this checkout.

**A plain local `./scripts/build.sh` retains the existing production workflow and replaces `/Applications/Finicky.app`.** For isolated development, use the explicit development flavor instead:

```sh
./scripts/install.sh
./scripts/build.sh --dev
./scripts/dev.sh js
```

`--dev` builds the native architecture to `apps/finicky/build/Finicky-Dev.app`, without installing it or changing system URL defaults. It preserves the production URL declarations (`http`, `https`, `finicky`) so it can receive real URL events. Its bundle ID is `se.johnste.finicky.dev.<worktree hash>`, stable for the canonical directory path across rebuilds and distinct between worktrees. The native duplicate-instance guard therefore cannot stop the installed production Finicky or another worktree's development app. Rebuilding or launching another copy with the **same** development identity can still replace a running instance of that identity; keep one copy per worktree.

The display name includes the identity suffix. `FinickyDevelopmentWorktree` in `Contents/Info.plist` records the source worktree. For a staged source copy, set `FINICKY_DEV_WORKTREE=/absolute/path/to/original/checkout` when building. The script anchors sources/output to its own directory and hashes the canonical override directory (including a trailing newline); Git supplies commit metadata only. Moving a worktree changes its identity unless you retain an override directory. Keep the artifact and recovery state until restoring handlers.

To build the production identity without installing, use `./scripts/build.sh --no-install`. This is useful for packaging inspection, but launching that same-ID artifact can trigger production default/duplicate behavior. Use `--dev` for concurrent development. Release/CI `BUILD_UNIVERSAL=1` still produces `Finicky.app`; `BUILD_TARGET_ARCH=arm64|amd64` still produces the architecture-specific production bundle. These modes never install, as before, and cannot be combined with `--dev`.

## Running and watching

`./scripts/dev.sh [--headless] <scenario> [Finicky flags...]` runs the development bundle directly without rebuilding. Existing scenarios remain `0|normal`, `1|none`, `2|js`, `3|json`, and `4|both`. They open the configuration window by default; `--headless` omits the script's `--window` flag. It does not change the application's existing window or routing behavior. `normal` reads your real configuration; the other scenarios use `testdata`. Pass `--dry-run` to avoid opening target browsers, for example:

```sh
./scripts/dev.sh --headless js --dry-run
```

Direct binary startup can implicitly register the app with macOS Launch Services, but development startup does not request default-handler changes. It may still read/write configuration and caches according to the selected scenario; `--dev` isolates application identity and installation, not your home directory.

With `fd` and `entr` installed, `./scripts/watch.sh` rebuilds only. `./scripts/watch-run.sh [--headless] <scenario> [Finicky flags...]` rebuilds and restarts only its own launched development process (defaults to `normal`). Neither uses `killall Finicky` or installs the app.

## Explicit URL handler testing

First inspect the current application paths without changing them:

```sh
./scripts/dev-handlers.sh status
# Equivalent native CLI:
apps/finicky/build/Finicky-Dev.app/Contents/MacOS/Finicky --url-handlers status
```

For an explicit event to the isolated bundle, after starting it with the desired scenario/configuration:

```sh
open -a "$(pwd)/apps/finicky/build/Finicky-Dev.app" 'https://example.com/finicky-dev-test'
```

This targets that app while preserving the system defaults. Launch Services may register the app when it launches. This confirms an Apple event dispatch to the selected app; it does not reproduce the original sender's Accessibility permissions/window title or prove that ordinary system clicks target it.

**The following opt-in commands change real system URL associations.** Only use them when you intend to route ordinary URL clicks through this worktree:

```sh
./scripts/dev-handlers.sh switch
# Test ordinary links from your actual sender application, then:
./scripts/dev-handlers.sh restore
./scripts/dev-handlers.sh status
```

The wrapper defaults to `apps/finicky/build/url-handlers.json`. Override it with `--handler-state /absolute/path/to/state.json` on both commands. The native CLI accepts `--url-handlers switch|restore --handler-state PATH` and exits before starting the GUI or reading configuration. Only bundles marked `FinickyDevelopment=true` may switch/restore.

Switch captures the exact previous application path for **each** scheme before registering or changing anything, writes a private snapshot exclusively, and waits for and verifies each macOS setter result. An existing snapshot blocks another switch. All schemes must already have restorable handlers (including `finicky`); if one is missing, switch refuses before making changes. Restore verifies that every current handler is either this development app or its saved original before writing. It refuses unexpected changes made by another app. A partial switch/restore failure retains the snapshot for retry; do not delete it, move the artifact, or clean the build directory until recovery completes. macOS may require user consent or reject a change. A crashed CLI can leave `state.json.lock`; remove that directory only after confirming no switch/restore process is active.

Restore resets defaults and removes the successful recovery snapshot. It does not unregister the development bundle from Launch Services. It does not stop or replace `/Applications/Finicky.app`. The snapshot covers default URL handlers, not other system settings.

## Verification

```sh
./scripts/test.sh
(cd packages/config-api && npm test -- --run)
python3 scripts/test-dev-workflow.py
```

The Go default-browser regression tests reject another same-ID app path and require all schemes to match the runtime identity/path. Handler tests use an injected registry, including partial setter failures, restoration retries, missing originals, existing recovery state, wrong-worktree state, and external changes. Script integration tests use fake build tools in a temporary source tree to validate safe output paths, worktree identity, preserved scheme declarations, production CI outputs, and scenario arguments. A real `--dev`/universal build verifies the native Cocoa and Go integration. Live registration and ordinary system click tests require the explicit workflow above; fake registry tests cannot establish macOS consent behavior.
