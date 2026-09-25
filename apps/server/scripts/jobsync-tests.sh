#!/bin/sh
# Runs the unit tests of the jobsync fork (apps/server/jobsync) with jobsync's own dependencies, which live only in
# the read-only clone <main checkout>/vendor/jobsync/node_modules (installed by spike S3). The link is removed after.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
fork="$here/jobsync"
main="$(git -C "$here" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
deps="$main/vendor/jobsync/node_modules"
if [ ! -d "$deps" ]; then
  echo "jobsync's dependencies are not installed at $deps (spike S3 installs them). Nothing was run." >&2
  exit 1
fi
if [ -e "$fork/node_modules" ] && [ ! -L "$fork/node_modules" ]; then
  echo "$fork/node_modules exists and is not a link; remove it first." >&2
  exit 1
fi
ln -sfn "$deps" "$fork/node_modules"
trap 'rm -f "$fork/node_modules"' EXIT
cd "$fork"
node node_modules/vitest/vitest.mjs run --reporter=dot
