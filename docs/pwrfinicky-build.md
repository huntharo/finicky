# Building PwrFinicky

PwrFinicky uses a native Go URL router and an Electron Settings helper. The router owns the product entrypoint and URL associations. It starts the helper with `--endpoint /path/to/endpoint.json`. Packaging does not install the app, launch either component, or change default browser settings.

## Prerequisites

- Node.js 24.15 or newer in the Node 24 line (or another version accepted by `apps/pwrfinicky/package.json`), npm, and Go 1.24 or newer.
- macOS builds require Xcode Command Line Tools. Build on macOS for CGO and code signing.
- Electron is pinned to **44.5.1**, Electron Packager to **20.3.0**, Playwright to **1.63.0**, and jsdom to **30.1.1**. The lockfile pins their transitive dependencies.
- Electron 44 supports macOS **13 Ventura and newer**, Windows 10 and newer, and supported Linux distributions. See the [Electron 44.5.1 platform support documentation](https://github.com/electron/electron/blob/v44.5.1/README.md#platform-support). The build reads the actual Settings bundle's minimum macOS version and uses the greater of that value and 13.0 for the outer app and Go deployment target.

No renderer bundler is used: `main.cjs`, `preload.cjs`, and the complete `renderer/` directory are copied into an ASAR archive. Runtime files must be self-contained; all current npm dependencies are development tools.

## Build and start

From the repository root:

```sh
cd apps/pwrfinicky
npm ci
npm run build
npm start
```

`npm start -- <arguments>` runs the packaged Go executable for the current host architecture and passes arguments unchanged. Build first. It never starts Electron directly. Launching the native app is a separate, explicit action from building it.

The default build targets the current operating system and architecture. Explicit targets use Electron names:

```sh
npm run build -- --platform darwin --arch arm64
npm run build -- --platform win32 --arch x64
npm run build -- --platform linux --arch x64
```

Supported CLI values are `darwin|win32|linux` and `arm64|x64`; Go receives `windows` for `win32` and `amd64` for `x64`. macOS uses `CGO_ENABLED=1`; Windows and Linux use `CGO_ENABLED=0`. Native runners are the supported CI path. Packager 20 uses its JavaScript resource editor for Windows metadata; Wine is not required for this unsigned packaging step. A cross-build does not verify runtime behavior on the target operating system.

Builds run `npm ci` and `npm run build` in `packages/config-api` first. The resulting `dist/finickyConfigAPI.js` is copied to `apps/finicky/src/router/config-api.js`, for the router's Go embed, and to `apps/finicky/src/assets/finickyConfigAPI.js`, for existing config/resolver test fixtures. Both are generated files; the backend integration must ignore `router/config-api.js` alongside the already ignored legacy asset. Do not commit the generated JavaScript.

To generate the API independently before Go tests:

```sh
npm run build:api
cd ../finicky/src
go test ./router ./config ./resolver ./rules ./browser ./diagnostics
cd ../../pwrfinicky
npm run build -- --skip-api
```

`--skip-api` requires the router's generated file to exist. It is intended for CI after generation and tests, not as a stale-cache detector. Avoid `go test ./...` here: the legacy module root still contains macOS-only Finicky code.

`--version 0.1.0` or `PWRFINICKY_VERSION` overrides the package version and Go `main.buildVersion` ldflag. macOS bundle version fields use the numeric version; archive names and the Go version retain prerelease suffixes. Commands are spawned with argument arrays, so paths with spaces and URL arguments never pass through a shell.

## Product layouts

macOS produces `apps/pwrfinicky/build/PwrFinicky.app`:

```text
PwrFinicky.app/
  Contents/
    Info.plist
    MacOS/PwrFinicky                        # native Go executable
    Resources/PwrFinicky Settings.app/      # Electron helper
```

The outer bundle ID is `com.pwrdrvr.pwrfinicky`, the display name is `PwrFinicky`, and `LSUIElement` is true. It declares `http`, `https`, and `pwrfinicky` URL schemes. The helper ID is `com.pwrdrvr.pwrfinicky.settings`; it declares no URL or document associations. The build checks this before signing. The Finicky icon is not reused.

Windows and Linux produce `apps/pwrfinicky/build/PwrFinicky-<platform>-<arch>/`:

```text
PwrFinicky-linux-x64/
  pwrfinicky                               # pwrfinicky.exe on Windows
  settings/                                # packaged Electron distribution
    PwrFinicky Settings                    # .exe on Windows
    resources/app.asar
  pwrfinicky.desktop                       # Linux only
```

The Linux desktop file uses `Exec=pwrfinicky %u` and declares MIME handlers for all three schemes. For a manual installation, keep `settings/` adjacent to the native executable and make `pwrfinicky` available on PATH, or edit the desktop file's `Exec` and `TryExec` to the installed native executable's absolute path. The build does not install that file or select MIME handlers. Default-handler integration still needs validation on the target desktop environment.

Windows output is a portable build directory. The explicit Settings action registers the current executable in the user's registry and opens Windows Default Apps for user selection. Protocol activation and user-choice behavior still need manual validation on Windows. A successful build does not establish tested default-handler behavior.

## Signing and archives

Local macOS builds ad-hoc sign the nested Settings app and then the native outer app. The final bundle is verified with `codesign --verify --deep --strict`. Ad-hoc signing supports local testing; it is not a notarized distribution signature.

Optional environment variables enable a future release-signing workflow:

| Variable | Purpose |
| --- | --- |
| `PWRFINICKY_SIGN_IDENTITY` | Existing Developer ID Application identity. Electron Packager signs the helper with hardened runtime support, then the build signs the outer bundle. |
| `PWRFINICKY_NOTARY_PROFILE` | Existing `notarytool` keychain profile. Requires the signing identity, submits the assembled app, waits for acceptance, and staples/validates the result. |

Provision identities and profiles separately. The scripts do not import certificates, configure keychains, retrieve credentials, or modify default handlers. CI does not wire in signing secrets; its macOS artifacts are ad-hoc signed. The release-signing/notarization path needs verification with release credentials before distributing a release.

Archive an existing build with the same target/version options:

```sh
npm run package -- --platform darwin --arch arm64
```

Archives go to `build/artifacts/PwrFinicky-<platform>-<arch>-<version>.zip` on macOS and `.tar.gz` on Windows/Linux. macOS uses `ditto`; other platforms use `tar`. Archiving preserves bundle symlinks and executable permissions that a bare Actions artifact upload can lose. A `build-info.json` in the product records the build's actual version and target; `package` checks it before naming the archive. The repository license is included alongside this metadata. `package` does not rebuild or publish anything.

## Tests and CI

```sh
npm run test:build
npm test
npm run test:electron
```

The build-script tests use isolated fixtures under the ignored `build/` directory. They validate layouts, generated API copies, native launch paths, argument preservation, Go target mapping, helper associations, signing order, and failure behavior. They do not substitute for launching the integrated native host and Settings UI. `npm test` runs the application tests supplied with the Settings implementation.

`test:electron` requires a complete build. It launches the packaged Settings helper and real Go router with a disposable data directory, saves visual rules, previews routing, verifies invalid JS/TS edits retain the last working config, recovers from an atomic replacement, closes Settings, and dispatches a URL with Settings closed. It uses dry-run mode and never changes default handlers. On macOS it sends real URL AppleEvents to both an already running router and a cold app launch, checking neither opens Settings; Windows/Linux exercise the second-process URL forwarding entrypoint. Screenshots, process IDs, timing evidence, and logs remain under `build/electron-smoke-*`. Cleanup targets only its captured child processes and authenticated router endpoint. Run under `xvfb-run --auto-servernum` on a headless Linux desktop.

For a deliberate browser handoff, `npm run test:electron -- --launch-browser` opens one example.com link in the selected browser. The locally verified macOS run used Electron 44.5.1, resolved in 2.4 ms, and completed the Safari handoff in 69 ms with Settings closed; this is one smoke-test measurement, not a latency guarantee. HTTP/HTTPS associations were identical before and after.

Settings has no cookies or authentication storage. The packaged Electron cookie-encryption fuse is disabled before signing to avoid unnecessary Keychain prompts. This does not disable the renderer sandbox or context isolation.

For an optional real-toolchain check, run `npm run test:package` (or pass `-- --platform win32 --arch x64`, for example). It compiles and packages a disposable fixture using the real npm, Go, Electron Packager, signing, and archiving tools. It downloads Electron if needed, never launches the fixture, and removes its temporary product afterward. Production application sources are not required for this check.

`.github/workflows/pwrfinicky.yml` runs on pushes to `pwrfinicky`, PRs targeting `pwrfinicky`, manual dispatch, and `pwrfinicky-v*` tags. Native macOS ARM64, Windows x64, and Linux x64 jobs generate the API, run the selected Go packages, run build-script and application tests, build, exercise the packaged Electron/Go integration, and upload archives and test evidence. Linux integration tests run under Xvfb. Runner architecture is asserted before building.

Tags supply the version after `pwrfinicky-v`. If repository variable `PWRFINICKY_ENABLE_RELEASES` is exactly `true`, a successful tag build also creates a **draft** GitHub release containing those archives. It does not publish the draft or imply that Windows/Linux default-handler behavior or credentialed macOS signing has been verified.
