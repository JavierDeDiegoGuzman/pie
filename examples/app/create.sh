#!/usr/bin/env bash
# Creates an instance of the app from the template: its own folder and git repo, with
# pie-agent and @pie-agent/plugins packed from this repo (run `pnpm build` first).
#   examples/app/create.sh ~/pie-app
set -euo pipefail
TARGET=$(realpath -m "${1:-$HOME/pie-app}")
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
[ -e "$TARGET/package.json" ] && { echo "$TARGET already has an app"; exit 1; }
mkdir -p "$TARGET/.vendor"
(cd "$ROOT/packages/sdk" && pnpm pack --pack-destination "$TARGET/.vendor" >/dev/null)
(cd "$ROOT/packages/plugins" && pnpm pack --pack-destination "$TARGET/.vendor" >/dev/null)
cp -r "$HERE/template/." "$TARGET/"
cd "$TARGET"
npm install --no-audit --no-fund --loglevel=error
git init -q
git config user.name "Pie" && git config user.email "pie@localhost"   # the agent commits as Pie
npm run --silent check
git add -A && git commit -q -m "the app, from the template"
bash scripts/release.sh
echo "created $TARGET"
