#!/usr/bin/env bash
# Stop the stack started by scripts/e2e-up.sh and remove its temp dirs.
set -uo pipefail
cd "$(dirname "$0")/.."

STATE=.e2e-data/state.json
if [ ! -f "$STATE" ]; then
  echo "scripts/e2e-down.sh: nothing to stop (no $STATE)"
  exit 0
fi

read_json() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k], s); process.stdout.write(v===undefined||v===null?"":String(v))' "$STATE" "$1"; }

UP_PID=$(read_json pid)
BITCOIND_PID=$(read_json bitcoind.pid)
BITCOIND_DATADIR=$(read_json bitcoind.datadir)
LND_PID=$(read_json lnd.pid)
LND_DIR=$(read_json lnd.lnddir)
STOP_FILE=$(read_json stopFile)

# Preferred path: ask the running e2e-up process to shut everything down cleanly.
if [ -n "$UP_PID" ] && kill -0 "$UP_PID" 2>/dev/null; then
  touch "$STOP_FILE"
  for _ in $(seq 1 60); do
    kill -0 "$UP_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$UP_PID" 2>/dev/null; then
    echo "e2e-up did not exit in time; killing it" >&2
    kill -9 "$UP_PID" 2>/dev/null || true
  fi
fi

# Fallback: the runner is gone but daemons may still be alive.
for pid in "$LND_PID" "$BITCOIND_PID"; do
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
done
[ -n "$LND_DIR" ] && rm -rf "$LND_DIR"
[ -n "$BITCOIND_DATADIR" ] && rm -rf "$BITCOIND_DATADIR"
rm -f "$STATE" "$STOP_FILE"
echo "e2e stack stopped"
