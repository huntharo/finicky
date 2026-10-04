#!/bin/bash
# Run Finicky in a specific test scenario without building.
#
# Usage:
#   ./scripts/dev.sh [--headless] <scenario> [Finicky flags...]
#
# Scenarios:
#   0  normal  Auto-detect configs
#   1  none    No JS config, no rules.json
#   2  js      JS config only
#   3  json    rules.json only
#   4  both    JS config + rules.json
#
# Environment variables:
#   FINICKY_MOCK_UPDATE=1.99.0  Show update banner with given version

set -euo pipefail
cd "$(dirname "$0")/.."

BINARY="apps/finicky/build/Finicky-Dev.app/Contents/MacOS/Finicky"
JS_CONFIG="$(pwd)/testdata/config.js"
JSON_RULES="$(pwd)/testdata/rules.json"
NO_RULES="${TMPDIR:-/tmp}/finicky-dev-no-rules-$(uuidgen).json"  # unique per run, intentionally absent

if [[ -n "${FINICKY_MOCK_UPDATE:-}" ]]; then
  echo "Mock update enabled: v${FINICKY_MOCK_UPDATE:-}"
fi

WINDOW_ARGS=(--window)
if [[ "${1:-}" = --headless ]]; then
  WINDOW_ARGS=()
  shift
fi
SCENARIO="${1:-}"
if [[ -z "$SCENARIO" ]]; then
  echo "Usage: $0 [--headless] <scenario> [Finicky flags...]"
  echo ""
  echo "  0  normal  Auto-detect configs"
  echo "  1  none    No JS config, no rules.json"
  echo "  2  js      JS config only  ($JS_CONFIG)"
  echo "  3  json    rules.json only ($JSON_RULES)"
  echo "  4  both    JS config + rules.json"
  echo ""
  echo "Environment variables:"
  echo "  FINICKY_MOCK_UPDATE=1.99.0  Show update banner with given version"
  exit 0
fi

shift
if [[ ! -x "$BINARY" ]]; then
  echo "Build the development app first: ./scripts/build.sh --dev" >&2
  exit 1
fi
case "$SCENARIO" in
  0|normal)
    echo "Scenario 0: normal (auto-detect configs)"
    exec "$BINARY" ${WINDOW_ARGS[@]+"${WINDOW_ARGS[@]}"} "$@"
    ;;
  1|none)
    echo "Scenario 1: no JS config, no rules.json"
    exec "$BINARY" ${WINDOW_ARGS[@]+"${WINDOW_ARGS[@]}"} --no-config --rules "$NO_RULES" "$@"
    ;;
  2|js)
    echo "Scenario 2: JS config only"
    exec "$BINARY" ${WINDOW_ARGS[@]+"${WINDOW_ARGS[@]}"} --config "$JS_CONFIG" --rules "$NO_RULES" "$@"
    ;;
  3|json)
    echo "Scenario 3: rules.json only"
    exec "$BINARY" ${WINDOW_ARGS[@]+"${WINDOW_ARGS[@]}"} --no-config --rules "$JSON_RULES" "$@"
    ;;
  4|both)
    echo "Scenario 4: JS config + rules.json"
    exec "$BINARY" ${WINDOW_ARGS[@]+"${WINDOW_ARGS[@]}"} --config "$JS_CONFIG" --rules "$JSON_RULES" "$@"
    ;;
  *)
    echo "Unknown scenario: $SCENARIO"
    echo ""
    echo "  0  normal  Auto-detect configs"
    echo "  1  none    No JS config, no rules.json"
    echo "  2  js      JS config only  ($JS_CONFIG)"
    echo "  3  json    rules.json only ($JSON_RULES)"
    echo "  4  both    JS config + rules.json"
    exit 1
    ;;
esac
