#!/usr/bin/env bash
# Publish the NCL demo: sync from the working folder, commit, push.
# GitHub Pages rebuilds on push; changes are live ~1 minute later.
#
# The site is the row demo alone, served at the site root. This repository is
# public, so only the files the browser loads are copied: no README, no
# generators, no model code, no video.
#
#   ./deploy.sh          sync, commit, push
#   ./deploy.sh --stage  sync only, to check the result locally first
set -euo pipefail

SRC="/Users/akashmalhotra/NCL/demos"
DST="$(cd "$(dirname "$0")" && pwd)"
ROW="$SRC/ncl_demo_row"

cp "$ROW/index.html" "$ROW/row.js" "$ROW/row_data.js" "$ROW/styles.css" "$ROW/tokens.css" "$DST/"
# -L dereferences symlinks, --delete removes files deleted in the source
rsync -aL --delete --exclude .DS_Store "$ROW/vendor/" "$DST/vendor/"
cp "$SRC/ncl_demo_combined/gate.js" "$SRC/ncl_demo_combined/agent.js" \
   "$SRC/ncl_demo_combined/config.js" "$DST/"
# at the site root the shared scripts sit beside the page, not one level up
sed -E -i '' 's#"\.\./(gate|config|agent)\.js#"\1.js#g' "$DST/index.html"

if [ "${1:-}" = "--stage" ]; then
  echo "Staged in $DST, nothing committed."
  exit 0
fi

cd "$DST"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "Update demo ($(date '+%Y-%m-%d %H:%M'))"
  # absorb commits GitHub makes on the remote (e.g. the CNAME file)
  git pull --rebase --quiet
  git push
  echo "Published. Live in about a minute at https://demo.neuralcontinuitylab.com"
else
  echo "No changes to publish."
fi
