#!/usr/bin/env bash
# Applies your edits to the app: check, commit, restart.
#   npm run apply -- "what changed"
# The check is types + the web build + a boot test. If it fails, nothing is applied.
# The restart happens a second after this script returns, so its output reaches you first;
# the service manager starts the new version and your run continues there.
set -uo pipefail
cd "$(dirname "$0")/.."
if ! output=$(npm run --silent check 2>&1); then
  echo "$output" | tail -80
  echo
  echo "NOT applied: the check failed. Fix it and run npm run apply again."
  exit 1
fi
git add -A && git commit -q -m "${1:-apply}" || true
if [ -n "${PIE_APP_PID:-}" ]; then
  setsid nohup sh -c "sleep 1; kill -TERM $PIE_APP_PID" >/dev/null 2>&1 </dev/null &
  echo "Applied and committed. The app restarts in a second; you continue on the new code."
else
  echo "Applied and committed. (Not running inside the app: restart it yourself.)"
fi
