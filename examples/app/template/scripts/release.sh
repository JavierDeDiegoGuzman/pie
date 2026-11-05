#!/usr/bin/env bash
# The release: a copy of the last commit, with its web build, that the service runs (from .release/).
# Edits in the working copy never run until `npm run apply` commits them and calls this.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .release.new && mkdir .release.new
git archive HEAD | tar -x -C .release.new
ln -s ../node_modules .release.new/node_modules
(cd .release.new && node web/build.mjs)
rm -rf .release.old
if [ -d .release ]; then mv .release .release.old; fi
mv .release.new .release && rm -rf .release.old
