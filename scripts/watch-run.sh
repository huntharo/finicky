#!/bin/bash
# entr owns only the development process it launches and restarts.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$#" -gt 0 ] || set -- normal
fd . --type f --exclude build --exclude node_modules --exclude dist --exclude src/assets packages/config-api packages/finicky-ui apps/finicky \
  | entr -r sh -c './scripts/build.sh --dev && exec ./scripts/dev.sh "$@"' sh "$@"
