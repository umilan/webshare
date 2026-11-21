#!/usr/bin/env bash
# Commit is expected to be done already. Pushes the current branch, merges it into main,
# and syncs docs/ to the gh-pages branch (live at https://umilan.github.io/webshare/).
set -euo pipefail
cd "$(dirname "$0")"
BR=$(git rev-parse --abbrev-ref HEAD)
git push -q origin "$BR"
[ "$BR" != main ] && git push -q origin "$BR":main
W=$(mktemp -d)
git fetch -q origin gh-pages
git worktree add -q "$W" FETCH_HEAD
cp -r docs/. "$W"/
( cd "$W" && git add -A && { git diff --cached --quiet || git commit -qm "Publish $(git -C .. rev-parse --short HEAD 2>/dev/null || echo update)"; } && git push -q origin HEAD:gh-pages )
git worktree remove --force "$W"
echo "Published: https://umilan.github.io/webshare/"
