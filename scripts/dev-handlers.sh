#!/bin/bash
# Explicitly inspect, switch, or restore development URL handlers.
set -euo pipefail
cd "$(dirname "$0")/.."
ACTION="${1:-status}"
[ "$#" = 0 ] || shift
BINARY="$(pwd)/apps/finicky/build/Finicky-Dev.app/Contents/MacOS/Finicky"
if [ ! -x "$BINARY" ]; then
    echo "Build the development app first: ./scripts/build.sh --dev" >&2
    exit 1
fi
exec "$BINARY" --url-handlers "$ACTION" --handler-state "$(pwd)/apps/finicky/build/url-handlers.json" "$@"
