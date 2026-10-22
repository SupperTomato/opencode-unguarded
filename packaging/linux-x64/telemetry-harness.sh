#!/usr/bin/env bash
# Telemetry egress harness with a positive control.
#
# Usage: telemetry-harness.sh <candidate-binary> <stock-binary>
#
# Each binary runs against its own fresh OTLP collector with telemetry enabled.
# The stock binary must be observed sending telemetry; the candidate must send
# none. This distinguishes "telemetry disabled" from "harness never worked".
set -euo pipefail

# Resolve both binaries before any `cd`, so a relative path from the caller's
# directory keeps working once the harness changes directory.
candidate_arg="${1:-}"
stock_arg="${2:-}"
case "$candidate_arg" in
  ""|-*) echo "usage: telemetry-harness.sh <candidate-binary> <stock-binary>" >&2; exit 1 ;;
esac
case "$stock_arg" in
  ""|-*) echo "usage: telemetry-harness.sh <candidate-binary> <stock-binary>" >&2; exit 1 ;;
esac
candidate="$(cd -P -- "$(dirname -- "$candidate_arg")" && pwd)/$(basename -- "$candidate_arg")"
stock="$(cd -P -- "$(dirname -- "$stock_arg")" && pwd)/$(basename -- "$stock_arg")"
[ -x "$candidate" ] || { echo "candidate binary is not executable: $candidate" >&2; exit 1; }
[ -x "$stock" ] || { echo "stock binary is not executable: $stock" >&2; exit 1; }
script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -P "$script_dir/../.." && pwd)"
collector_script="$repo_dir/script/unguarded/collector.ts"
[ -f "$collector_script" ] || collector_script="$script_dir/collector.ts"
[ -f "$collector_script" ] || { echo "collector.ts not found" >&2; exit 1; }
[ -f "$script_dir/model-stub.ts" ] || { echo "model-stub.ts not found next to the harness" >&2; exit 1; }
work="$(mktemp -d)"
collectors=()
children=()
models=()

cleanup() {
  for pid in "${children[@]:-}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  for pid in "${collectors[@]:-}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  for pid in "${models[@]:-}"; do
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
  local home="$work/$name-home"
  local project="$work/$name-project"
  mkdir -p "$profile/data" "$profile/config/opencode" "$profile/cache" "$profile/state" "$profile/tmp" "$home" "$project"
  # The stub model asks for this exact file and only accepts a tool result that
  # echoes these contents. A session that never executes a successful read
  # cannot report them.
  local expected="harness-tool-output-$name-$RANDOM$RANDOM"
  printf '%s\n' "$expected" > "$project/harness-target.txt"
  # The shared stub reads this file per request, so each exercise has its own
  # unpredictable expected value.
  printf '%s' "$expected" > "$work/model.expected"

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

  # The candidate's profile must be explicit: XDG isolation alone does not
  # confine a raw derivative binary, which reads its own profile variable. HOME
  # is isolated too, so neither binary can reach real user state.
  local env=(
    "HOME=$home"
    "XDG_DATA_HOME=$profile/data"
    "XDG_CONFIG_HOME=$profile/config"
    "XDG_CACHE_HOME=$profile/cache"
    "XDG_STATE_HOME=$profile/state"
    "TMPDIR=$profile/tmp"
    "OPENCODE_UNGUARDED_PROFILE=$profile"
    "OPENCODE_DISABLE_AUTOUPDATE=1"
    "OPENCODE_DISABLE_MODELS_FETCH=1"
    "NO_COLOR=1"
  )

  # A local, deterministic OpenAI-compatible model. The session below must run
  # real model and tool handling offline, so success cannot depend on network
  # access or a provider account.
  local model_port
  model_port="$(cat "$work/model.port")"
  cat > "$profile/config/opencode/opencode.json" <<JSON
{
  "providers": {
    "harness": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "Harness",
      "settings": { "baseURL": "http://127.0.0.1:$model_port/v1", "apiKey": "harness" },
      "models": { "stub": { "name": "Stub" } }
    }
  }
}
JSON

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
  local ready=0 url=""
  for _ in $(seq 1 300); do
    url="$(grep -oE 'https?://[^ ]+' "$work/$name.serve.log" 2>/dev/null | head -1 || true)"
    if [ -n "$url" ]; then ready=1; break; fi
    if ! kill -0 "$server" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    echo "$name server did not become ready" >&2
    cat "$work/$name.serve.log" >&2
    exit 1
  fi

  # Readiness is proven through the real API, not a log line. The foreground
  # server prints its one-off password; authenticate so a 401 is not mistaken
  # for an unavailable server.
  local password
  password="$(sed -n 's/^server password //p' "$work/$name.serve.log" | head -1)"
  local auth=()
  [ -n "$password" ] && auth=(-u "opencode:$password")
  if ! curl -fsS --max-time 5 "${auth[@]}" "$url/api/info" >"$work/$name.info.json" 2>"$work/$name.info.err"; then
    echo "$name server did not answer /api/info" >&2
    cat "$work/$name.serve.log" "$work/$name.info.err" >&2
    exit 1
  fi

  # Drive a real session in the server this harness instrumented, so model and
  # tool execution are observed rather than run in an unrelated standalone
  # process. The password is passed through the environment, never argv.
  (cd "$project" && env "${env[@]}" OPENCODE_PASSWORD="$password" "$binary" run --server "$url" \
    --auto --model harness/stub \
    "Read harness-target.txt with the read tool." >"$work/$name.session.log" 2>&1) ||
    {
      echo "$name session failed" >&2
      cat "$work/$name.session.log" >&2
      exit 1
    }
  # The stub only returns this text after it receives the tool result, so this
  # assertion proves model tool execution happened, not just a text reply.
  if ! grep -q "$expected" "$work/$name.session.log"; then
    echo "$name session did not execute the read tool" >&2
    cat "$work/$name.session.log" >&2
    exit 1
  fi

  # The server must still be alive after the session; a crash after readiness is
  # a failure, not an absence of telemetry.
  if ! kill -0 "$server" 2>/dev/null; then
    echo "$name server exited during the session" >&2
    cat "$work/$name.serve.log" >&2
    exit 1
  fi

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

start_model() {
  PORTFILE="$work/model.port" EXPECTED_FILE="$work/model.expected" bun "$script_dir/model-stub.ts" >"$work/model.log" 2>&1 &
  models+=("$!")
  for _ in $(seq 1 100); do
    [ -f "$work/model.port" ] && return 0
    sleep 0.1
  done
  echo "model stub failed to start" >&2
  cat "$work/model.log" >&2
  exit 1
}

start_model
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
