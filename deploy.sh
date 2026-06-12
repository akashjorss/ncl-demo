#!/usr/bin/env bash
# Publish the NCL demo: sync from the working folders, commit, push.
# GitHub Pages rebuilds on push; changes are live ~1 minute later.
set -euo pipefail

SRC="/Users/akashmalhotra/Projects/Neural Continuity Labs"
DST="$(cd "$(dirname "$0")" && pwd)"

# -L dereferences symlinks, --delete removes files you deleted in the source
rsync -aL --delete --exclude .DS_Store "$SRC/ncl_demo/"    "$DST/ncl_demo/"
rsync -aL --delete --exclude .DS_Store "$SRC/ncl_demo_3d/" "$DST/ncl_demo_3d/"
cp "$SRC/ncl_demo_combined/index.html" "$SRC/ncl_demo_combined/styles.css" "$DST/"

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
