#!/usr/bin/env bash
# Telemetry egress harness with a positive control.
#
# Usage: telemetry-harness.sh <candidate-binary> <stock-binary>
#
# Each binary runs against its own fresh OTLP collector with telemetry enabled.
# The stock binary must be observed sending telemetry; the candidate must send
# none. This distinguishes "telemetry disabled" from "harness never worked".
set -euo pipefail

candidate="${1:?usage: telemetry-harness.sh <candidate-binary> <stock-binary>}"
stock="${2:?usage: telemetry-harness.sh <candidate-binary> <stock-binary>}"
script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -P "$script_dir/../.." && pwd)"
collector_script="$repo_dir/script/unguarded/collector.ts"
[ -f "$collector_script" ] || collector_script="$script_dir/collector.ts"
[ -f "$collector_script" ] || { echo "collector.ts not found" >&2; exit 1; }
work="$(mktemp -d)"
collectors=()
children=()

cleanup() {
  for pid in "${children[@]:-}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  for pid in "${collectors[@]:-}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

start_collector() {
  local name="$1"
  COLLECTOR_PORT_FILE="$work/$name.port" COLLECTOR_HITS_FILE="$work/$name.hits" \
    COLLECTOR_DURATION_MS=120000 bun "$collector_script" >"$work/$name.log" 2>&1 &
  collectors+=("$!")
  for _ in $(seq 1 100); do
    [ -f "$work/$name.port" ] && return 0
    sleep 0.1
  done
  echo "collector $name failed to start" >&2
  cat "$work/$name.log" >&2
  exit 1
}

# exercise <name> <binary>: run the candidate/stock against its collector.
exercise() {
  local name="$1" binary="$2" port
  port="$(cat "$work/$name.port")"
  local profile="$work/$name-profile"
  mkdir -p "$profile/data" "$profile/config" "$profile/cache" "$profile/state" "$profile/tmp"

  # General and signal-specific endpoints: an exporter activated through either
  # environment path must be observable.
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$port"
  export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="http://127.0.0.1:$port"
  export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://127.0.0.1:$port"
  export OTEL_SDK_DISABLED=false
  export OTEL_TRACES_EXPORTER=otlp
  export OTEL_LOGS_EXPORTER=otlp
  export OTEL_BSP_SCHEDULE_DELAY=100
  export OTEL_BLRP_SCHEDULE_DELAY=100

  local env=(
    "XDG_DATA_HOME=$profile/data"
    "XDG_CONFIG_HOME=$profile/config"
    "XDG_CACHE_HOME=$profile/cache"
    "XDG_STATE_HOME=$profile/state"
    "TMPDIR=$profile/tmp"
    "NO_COLOR=1"
  )

  # Each exercise must succeed. A crashed candidate would otherwise emit no
  # telemetry and look identical to a correctly patched build.
  env "${env[@]}" "$binary" --version >"$work/$name.version.log" 2>&1 ||
    { echo "$name failed --version" >&2; cat "$work/$name.version.log" >&2; exit 1; }
  env "${env[@]}" "$binary" debug paths >"$work/$name.paths.log" 2>&1 ||
    { echo "$name failed debug paths" >&2; cat "$work/$name.paths.log" >&2; exit 1; }

  # Start a real server and wait until it reports its listening address.
  env "${env[@]}" "$binary" serve --port 0 >"$work/$name.serve.log" 2>&1 &
  local server=$!
  children+=("$server")
  local ready=0
  for _ in $(seq 1 200); do
    if grep -q "http://" "$work/$name.serve.log" 2>/dev/null; then ready=1; break; fi
    if ! kill -0 "$server" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    echo "$name server did not become ready" >&2
    cat "$work/$name.serve.log" >&2
    exit 1
  fi
  sleep 3
  kill "$server" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
  sleep 1
}

wait_for_hits() {
  local name="$1"
  for _ in $(seq 1 600); do
    [ -f "$work/$name.hits" ] && return 0
    sleep 0.1
  done
  return 1
}

start_collector candidate
start_collector stock

exercise candidate "$candidate"
exercise stock "$stock"

for name in candidate stock; do
  for pid in "${collectors[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  if ! wait_for_hits "$name"; then
    echo "collector $name did not report hits" >&2
    exit 1
  fi
done

candidate_hits="$(cat "$work/candidate.hits")"
stock_hits="$(cat "$work/stock.hits")"
echo "candidate hits: $candidate_hits"
echo "stock hits: $stock_hits"

if [ "$stock_hits" = "[]" ]; then
  echo "positive control failed: stock upstream emitted no telemetry through this harness" >&2
  exit 1
fi
if [ "$candidate_hits" != "[]" ]; then
  echo "telemetry egress detected from the candidate: $candidate_hits" >&2
  exit 1
fi

echo "telemetry harness passed: stock emitted telemetry, candidate emitted none"
