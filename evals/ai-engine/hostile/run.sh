#!/usr/bin/env bash
# Hostile evaluation of the jobleft ai-engine lane (acceptance outcomes docs/outcomes/ai-engine.md, O1-O15).
#
#   TARGET_DIR=/path/to/worktree ./run.sh          # default TARGET_DIR: ~/jobleft-wt/ai-engine
#   ONLY="o06 o07" ./run.sh                        # run a subset (file-name prefixes)
#   O13_TRIES=5 ./run.sh                           # tries per job for the real-local-model probe
#
# Every product process runs under a macOS sandbox that allows loopback only (lib/loopback-only.sb) with an
# in-process connect/DNS monitor (lib/netmon.mjs), so no probe can reach a real host. The stand-ins
# (lib/standin_model.py, lib/standin_publik.py) are evaluator-written from public wire formats and the publik
# contract (data/publik-contract-excerpt.md); they share no code with jobleft. O11/O13 use a local Ollama when one is
# running (qwen2.5:7b was used); without it O13 prints "blocked". Results: out/<probe>-results.json.
# Exit status: 0 only when every probe passes (every check, including negative controls failing as intended).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export TARGET_DIR="${TARGET_DIR:-$HOME/jobleft-wt/ai-engine}"
command -v node >/dev/null || { echo "node (24+) is required"; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }
command -v sandbox-exec >/dev/null || { echo "sandbox-exec (macOS) is required"; exit 2; }
[ -f "$TARGET_DIR/packages/ai-engine/src/cli.ts" ] || { echo "no ai-engine CLI under TARGET_DIR=$TARGET_DIR"; exit 2; }
mkdir -p "$HERE/out"
PROBES="nc_negative_controls o01_providers o02_publik_connect o03_setup_check o04_timeouts_cancel o05_no_provider o06_out_of_money o07_balance o08_key_secrecy o09_key_routing o10_no_fallback o11_local_offline o12_bad_answers o13_local_model_quality o14_local_api_security o15_metered x_robustness"
FAILED=""
for p in $PROBES; do
  if [ -n "${ONLY:-}" ]; then
    keep=0; for o in $ONLY; do case "$p" in "$o"*) keep=1;; esac; done
    [ "$keep" = 1 ] || continue
  fi
  echo "=== $p"
  if python3 "$HERE/probes/$p.py" > "$HERE/out/$p.stdout" 2>&1; then
    tail -1 "$HERE/out/$p.stdout"
  else
    grep '"pass": false' "$HERE/out/$p.stdout" | cut -c1-240
    tail -1 "$HERE/out/$p.stdout"
    FAILED="$FAILED $p"
  fi
done
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"
  exit 1
fi
echo "ALL PROBES PASSED"
exit 0
