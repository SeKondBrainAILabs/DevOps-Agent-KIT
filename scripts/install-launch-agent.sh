#!/bin/bash
# =============================================================================
# Run KIT for DevOps unattended on a Mac (KC-S2.2.3)
#
# Installs a per-user LaunchAgent that starts the app at login and restarts it
# after a crash, then waits for its MCP server to answer GET /health.
#
#   scripts/install-launch-agent.sh              install (or reinstall) and check
#   scripts/install-launch-agent.sh --dry-run    print the plist, change nothing
#   scripts/install-launch-agent.sh --uninstall  unload and remove it
#
# Environment:
#   KIT_APP_PATH        the .app bundle (default "/Applications/KIT for DevOps.app")
#   KIT_MCP_HEALTH_URL  health URL to wait for (default http://127.0.0.1:39100/health)
# =============================================================================

set -euo pipefail

LABEL="com.sekondbrain.kit-for-devops"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/launchd/$LABEL.plist.template"
APP_PATH="${KIT_APP_PATH:-/Applications/KIT for DevOps.app}"
APP_NAME="$(basename "$APP_PATH" .app)"
EXECUTABLE="$APP_PATH/Contents/MacOS/$APP_NAME"
LOG_DIR="$HOME/Library/Logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HEALTH_URL="${KIT_MCP_HEALTH_URL:-http://127.0.0.1:39100/health}"

render() {
  # '|' as the sed delimiter: app paths contain '/' and spaces, never '|'.
  sed -e "s|__APP_EXECUTABLE__|$EXECUTABLE|g" -e "s|__LOG_DIR__|$LOG_DIR|g" "$TEMPLATE"
}

case "${1:-}" in
  --dry-run)
    render
    exit 0
    ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: $0 [--dry-run|--uninstall]" >&2
    exit 2
    ;;
esac

if [[ "$OSTYPE" != darwin* ]]; then
  echo "LaunchAgents are macOS only; use --dry-run to see the plist" >&2
  exit 1
fi
if [[ ! -x "$EXECUTABLE" ]]; then
  echo "App not found at $EXECUTABLE (set KIT_APP_PATH)" >&2
  exit 1
fi

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
render > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# Reinstall cleanly: bootout fails harmlessly when it is not loaded yet.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST"

echo -n "Waiting for $HEALTH_URL "
for _ in $(seq 1 30); do
  if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "OK"
    curl -fsS -m 2 "$HEALTH_URL"
    echo
    exit 0
  fi
  echo -n "."
  sleep 2
done
echo
echo "The app did not answer on $HEALTH_URL within 60s; see $LOG_DIR/kit-for-devops.log" >&2
exit 1
