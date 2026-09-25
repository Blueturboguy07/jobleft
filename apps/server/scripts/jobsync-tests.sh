#!/bin/sh
# Runs the unit tests of the jobsync fork (apps/server/jobsync) with jobsync's own dependencies. They are not part of
# the jobleft workspace. The script looks for them in $JOBSYNC_DEPS, else in <main checkout>/vendor/jobsync/node_modules
# (installed by spike S3). Make them once, outside the repository, with:
#   mkdir -p /private/tmp/jl-jobsync-deps && cp apps/server/jobsync/package.json apps/server/jobsync/package-lock.json /private/tmp/jl-jobsync-deps/
#   (cd /private/tmp/jl-jobsync-deps && npm ci --ignore-scripts --no-audit --no-fund)
#   JOBSYNC_DEPS=/private/tmp/jl-jobsync-deps/node_modules apps/server/scripts/jobsync-tests.sh
# The script links the folder for the run and removes the link after.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
fork="$here/jobsync"
main="$(git -C "$here" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
deps="${JOBSYNC_DEPS:-$main/vendor/jobsync/node_modules}"
if [ ! -d "$deps" ]; then
  echo "jobsync's dependencies are not installed at $deps. Set JOBSYNC_DEPS (see the top of this script). Nothing was run." >&2
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
