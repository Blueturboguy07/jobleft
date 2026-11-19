#!/usr/bin/env bash
# The privileged steps of the live update proof (macos.sh), on a GitHub macOS runner only (passwordless sudo there):
# the TCC databases belong to root or are protected, and tcpdump needs root.
#   tcc-root.sh schema|grant|show ...   tcc.py as root (see tcc.py)
#   tcc-root.sh capture <file>          tcpdump of new TLS connections, with the process that opened each (pktap)
#   tcc-root.sh capture-stop
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  schema|grant|show) exec sudo "$(command -v python3)" -I "$HERE/tcc.py" "$@" ;;
  capture) exec sudo tcpdump -i pktap,all -k NP -n -l 'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0 and dst port 443' > "${2:?file}" 2>&1 ;;
  capture-stop) sudo pkill -INT -x tcpdump || true ;;
  *) echo "usage: tcc-root.sh schema|grant|show|capture|capture-stop ..." >&2; exit 2 ;;
esac
