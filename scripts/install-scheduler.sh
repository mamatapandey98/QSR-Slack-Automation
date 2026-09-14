#!/bin/bash
#
# Installs the daily 10:00 launchd job that sends QSR reminders.
# Safe to re-run: it replaces any previously installed copy.
#
#   ./scripts/install-scheduler.sh            # install
#   ./scripts/install-scheduler.sh --uninstall
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.leapfrog.qsr-reminder"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl unload "$TARGET" 2>/dev/null || true
  rm -f "$TARGET"
  echo "Removed $LABEL."
  exit 0
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH." >&2
  exit 1
fi

# launchd runs with a minimal environment, so the absolute node path matters.
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/out"
sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE_BIN|g" \
  "$REPO/scripts/$LABEL.plist" > "$TARGET"

launchctl unload "$TARGET" 2>/dev/null || true
launchctl load "$TARGET"

echo "Installed $LABEL"
echo "  node    $NODE_BIN"
echo "  repo    $REPO"
echo "  runs    daily at 10:00 local (= 10:00 NPT), acts only on reminder days"
echo "  log     $REPO/out/scheduler.log"
echo
echo "Verify with:  launchctl list | grep qsr"
