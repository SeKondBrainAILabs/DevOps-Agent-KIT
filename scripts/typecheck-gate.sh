#!/usr/bin/env bash
# Type-check gate for the electron project.
#
# `npm run build` does NOT type-check — electron-vite compiles with esbuild,
# which strips TypeScript types without checking them. A green build proves the
# code parses and nothing more. This script is the actual gate.
#
# The project does not type-check cleanly today (mostly TS7006 implicit-any on
# code written before noImplicitAny), so a zero-error gate is not reachable
# without a large unrelated cleanup. Instead this diffs against a recorded
# baseline and fails only on errors that are NEW.
#
#   scripts/typecheck-gate.sh           # fail if any new error appeared
#   scripts/typecheck-gate.sh --update  # re-record the baseline
set -uo pipefail
cd "$(dirname "$0")/.."
BASELINE=scripts/typecheck-baseline.txt

# Strip line/column numbers so unrelated edits above an error don't churn it.
# Both projects: the electron main/preload code and the renderer. Checking only
# one leaves half the branch ungated, which is how two undeclared properties on
# AgentInstance shipped unnoticed.
current=$(
  for cfg in tsconfig.electron.json tsconfig.renderer.json; do
    npx --no-install tsc --noEmit -p "$cfg" 2>&1 | sed "s|^|[$cfg] |"
  done \
  | grep -E "error TS[0-9]+" \
  | sed -E 's/\(([0-9]+),([0-9]+)\)//' \
  | sort)

if [ "${1:-}" = "--update" ]; then
  printf '%s\n' "$current" > "$BASELINE"
  echo "Baseline updated: $(printf '%s\n' "$current" | grep -c . ) errors recorded."
  exit 0
fi

if [ ! -f "$BASELINE" ]; then
  echo "No baseline at $BASELINE — run: scripts/typecheck-gate.sh --update" >&2
  exit 2
fi

new=$(comm -13 "$BASELINE" <(printf '%s\n' "$current"))
if [ -n "$new" ]; then
  echo "NEW type errors (not in baseline):" >&2
  printf '%s\n' "$new" >&2
  echo "" >&2
  echo "Fix them, or if genuinely pre-existing: scripts/typecheck-gate.sh --update" >&2
  exit 1
fi

fixed=$(comm -23 "$BASELINE" <(printf '%s\n' "$current") | grep -c . || true)
echo "No new type errors. ($fixed baseline error(s) now fixed.)"
