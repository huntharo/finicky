#!/bin/bash
# Rebuild only; do not install or stop any running app.
set -euo pipefail
cd "$(dirname "$0")/.."
fd . --type f --exclude build --exclude node_modules --exclude dist --exclude src/assets packages/config-api packages/finicky-ui apps/finicky \
  | entr -r ./scripts/build.sh --dev
