#!/bin/bash
# Build an isolated diagnostic artifact. Never install it or register URL handlers.
set -euo pipefail
cd "$(dirname "$0")/.."

# The default build.sh path installs into /Applications; always select this branch.
BUILD_TARGET_ARCH=arm64 bash scripts/build.sh

python3 - <<'PY'
from pathlib import Path
import json
import plistlib
import shutil

root = Path.cwd()
source = root / 'apps/finicky/build/Finicky-arm64.app'
artifact = root / 'apps/finicky/build/Finicky-Dispatch-Diagnostics.app'
overlay_dir = root / 'apps/finicky/build/dispatch-diagnostics'
overlay_dir.mkdir(parents=True, exist_ok=True)
shutil.copytree(source, artifact, dirs_exist_ok=True)

main = root / 'apps/finicky/src/main.go'
content = main.read_text()
start = content.index('\tgo func() {\n\t\tis_default_browser, err := setDefaultBrowser()')
end = content.index('\n\tnamespace :=', start)
content = content[:start] + '\tslog.Info("Diagnostic artifact: URL association changes disabled")\n' + content[end:]
(overlay_dir / 'main.go').write_text(content)

# Defense in depth: no Go caller in this artifact can invoke the native setter.
# Production browser.go hardcodes the production bundle identifier; changing the
# plist alone would not prevent system URL association changes.
browser = root / 'apps/finicky/src/browser.go'
content = browser.read_text()
start = content.index('func setDefaultHandlerForURLScheme(')
content = content[:start] + 'func setDefaultHandlerForURLScheme(bundleId string, scheme string) (bool, error) { return false, nil }\n'
(overlay_dir / 'browser.go').write_text(content)
(overlay_dir / 'overlay.json').write_text(json.dumps({'Replace': {
    str(main): str(overlay_dir / 'main.go'),
    str(browser): str(overlay_dir / 'browser.go'),
}}))

plist = artifact / 'Contents/Info.plist'
info = plistlib.loads(plist.read_bytes())
info['CFBundleIdentifier'] = 'se.johnste.finicky.dispatch-diagnostics'
info['CFBundleName'] = 'Finicky Dispatch Diagnostics'
info['CFBundleDisplayName'] = 'Finicky Dispatch Diagnostics'
for key in ('CFBundleURLTypes', 'CFBundleDocumentTypes', 'NSUserActivityTypes'):
    info.pop(key, None)
plist.write_bytes(plistlib.dumps(info))

# Synthetic rules allow stage attribution without reading the user's config.
(overlay_dir / 'test-config.ts').write_text('''export default {
  defaultBrowser: "Safari",
  options: { keepRunning: true, checkForUpdates: false, logRequests: false },
  handlers: [{
    match: (url) => {
      if (url.pathname.includes("slow")) {
        const start = Date.now();
        while (Date.now() - start < 650) {}
      }
      return false;
    },
    browser: "Safari"
  }]
};
''')
print('Isolated overlay: startup registration removed, setter disabled; distinct bundle ID, no URL/document/activity handlers.')
PY

COMMIT_HASH=$(git rev-parse --short HEAD)
BUILD_DATE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
CGO_ENABLED=1 GOARCH=arm64 CGO_CFLAGS="-mmacosx-version-min=12.0" CGO_LDFLAGS="-mmacosx-version-min=12.0" \
  go build -C apps/finicky/src \
    -overlay ../build/dispatch-diagnostics/overlay.json \
    -ldflags "-X 'finicky/version.commitHash=${COMMIT_HASH}' -X 'finicky/version.buildDate=${BUILD_DATE}'" \
    -o ../build/Finicky-Dispatch-Diagnostics.app/Contents/MacOS/Finicky
codesign --force --deep --sign - apps/finicky/build/Finicky-Dispatch-Diagnostics.app
echo "Runnable isolated artifact: $PWD/apps/finicky/build/Finicky-Dispatch-Diagnostics.app"
