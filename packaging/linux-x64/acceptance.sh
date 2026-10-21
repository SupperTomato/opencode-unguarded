#!/usr/bin/env bash
# End-to-end acceptance for a packaged opencode-unguarded archive.
#
# Usage: acceptance.sh <extracted-package-dir> <archive>
#
# Everything runs against a disposable HOME, so the release job exercises the
# exact packaged installer, launcher, executable, and uninstaller without
# touching the build machine's real installation or the stock OpenCode install.
set -euo pipefail

# Canonicalize before any `cd`: the release job passes a relative archive path.
package_arg="${1:-}"
archive_arg="${2:-}"
case "$package_arg" in
  ""|-*) echo "usage: acceptance.sh <extracted-package-dir> <archive>" >&2; exit 1 ;;
esac
case "$archive_arg" in
  ""|-*) echo "usage: acceptance.sh <extracted-package-dir> <archive>" >&2; exit 1 ;;
esac
package="$(cd -P -- "$package_arg" && pwd)" || { echo "package directory not found: $package_arg" >&2; exit 1; }
archive="$(cd -P -- "$(dirname -- "$archive_arg")" && pwd)/$(basename -- "$archive_arg")"
script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
cleanup() {
  if [ -n "${server:-}" ]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "acceptance: $*"; }
fail() {
  echo "acceptance FAILED: $*" >&2
  exit 1
}

export HOME="$work/home"
mkdir -p "$HOME"
unset OPENCODE_UNGUARDED_PROFILE OPENCODE_UNGUARDED_ROOT OPENCODE_DB 2>/dev/null || true

# --- install -----------------------------------------------------------------
pass "installing from the archive"
"$package/install.sh" --archive "$archive" >"$work/install.log" 2>&1 ||
  { cat "$work/install.log" >&2; fail "installer rejected the published archive"; }

prefix="$HOME/.local/opt/opencode-unguarded"
command="$HOME/.local/bin/opencode-unguarded"
[ -x "$prefix/libexec/opencode" ] || fail "installed executable is missing"
[ -L "$command" ] || fail "command link was not created"
[ -f "$prefix/BUILD-INFO.json" ] || fail "installed metadata is missing"
revision="$(jq -r .derivativeRevision "$prefix/BUILD-INFO.json")"
version="$(jq -r .version "$prefix/BUILD-INFO.json")"

reported="$("$command" --version)"
case "$reported" in
  *"v${version}-unguarded.${revision}"*) pass "installed version $reported" ;;
  *) fail "installed version '$reported' does not match metadata" ;;
esac

"$command" debug paths | grep -q "$HOME/.local/share/opencode-unguarded/profile" ||
  fail "installed command does not use the candidate profile"

# --- storage containment ------------------------------------------------------
pass "checking database override handling"
[ "$(OPENCODE_DB=:memory: "$command" debug paths | sed -n 's/^db *//p')" = ":memory:" ] ||
  fail ":memory: was not honored"
OPENCODE_DB=custom.db "$command" debug paths | grep -q "custom.db" || fail "custom database filename was not honored"
OPENCODE_DB=/etc/passwd "$command" debug paths >/dev/null 2>&1 && fail "absolute database override was accepted"
OPENCODE_DB=../escape.db "$command" debug paths >/dev/null 2>&1 && fail "traversing database override was accepted"
pass "database overrides behave as documented"

# --- dry run is read-only -----------------------------------------------------
pass "checking that uninstall --dry-run changes nothing"
mkdir -p "$HOME/.local/share/opencode-unguarded/profile/data/opencode"
echo durable >"$HOME/.local/share/opencode-unguarded/profile/data/opencode/durable.txt"
snapshot() { find "$HOME/.local/share/opencode-unguarded/profile" -type f -exec sha256sum {} + | sort; }
before="$(snapshot)"
"$command" uninstall --dry-run >"$work/dry.log" 2>&1 || { cat "$work/dry.log" >&2; fail "dry run failed"; }
[ "$before" = "$(snapshot)" ] || fail "dry run modified the profile"
pass "dry run left the profile unchanged"

# --- service identity ---------------------------------------------------------
pass "starting the managed service"
"$command" serve --service >"$work/serve.log" 2>&1 &
server=$!
registration="$HOME/.local/share/opencode-unguarded/profile/state/opencode/service-unguarded.json"
for _ in $(seq 1 300); do
  [ -f "$registration" ] && break
  kill -0 "$server" 2>/dev/null || { cat "$work/serve.log" >&2; fail "service exited before registering"; }
  sleep 0.1
done
[ -f "$registration" ] || { cat "$work/serve.log" >&2; fail "service did not register"; }

jq -e --arg v "$revision" \
  '.derivative == "opencode-unguarded" and .derivativeRevision == $v and (.installation | type == "string")' \
  "$registration" >/dev/null || fail "registration does not carry the derivative build and installation identity"
[ -n "$(jq -r '.startTime // empty' "$registration")" ] || pass "note: no process start time on this platform"

url="$(jq -r .url "$registration")"
password="$(jq -r .password "$registration")"
curl -fsS -u "opencode:$password" --max-time 5 "$url/api/info" >"$work/info.json" ||
  fail "managed service did not answer /api/info"
jq -e --arg v "$revision" \
  '.derivative == "opencode-unguarded" and .derivativeRevision == $v' "$work/info.json" >/dev/null ||
  fail "live service does not report the same derivative identity"
pass "live service identity matches the registration"

# --- session ------------------------------------------------------------------
pass "running a session against a packaged install"
model_port_file="$work/model.port"
PORTFILE="$model_port_file" bun "$script_dir/model-stub.ts" >"$work/model.log" 2>&1 &
model=$!
for _ in $(seq 1 100); do
  [ -f "$model_port_file" ] && break
  sleep 0.1
done
[ -f "$model_port_file" ] || { cat "$work/model.log" >&2; fail "model stub did not start"; }
model_port="$(cat "$model_port_file")"
mkdir -p "$HOME/.local/share/opencode-unguarded/profile/config/opencode" "$work/project"
jq -n --arg url "http://127.0.0.1:$model_port/v1" \
  '{providers:{harness:{package:"@opencode/ai/providers/openai-compatible",name:"Harness",
    settings:{baseURL:$url,apiKey:"harness"},models:{stub:{name:"Stub"}}}}}' \
  >"$HOME/.local/share/opencode-unguarded/profile/config/opencode/opencode.json"
(cd "$work/project" && OPENCODE_DISABLE_MODELS_FETCH=1 "$command" run --standalone --auto \
  --model harness/stub "Reply with the single word ok." >"$work/session.log" 2>&1) ||
  { cat "$work/session.log" >&2; fail "session did not complete"; }
grep -qi "ok" "$work/session.log" || { cat "$work/session.log" >&2; fail "session produced no answer"; }
kill "$model" 2>/dev/null || true
pass "session completed with a packaged install"

# --- uninstall ----------------------------------------------------------------
pass "uninstalling while the service is running"
echo stock >"$HOME/stock.txt"
bash "$prefix/uninstall.sh" --force >"$work/uninstall.log" 2>&1 ||
  { cat "$work/uninstall.log" >&2; fail "packaged uninstaller failed"; }
[ ! -e "$prefix" ] || fail "program directory was not removed"
[ ! -e "$command" ] || fail "command link was not removed"
[ -f "$HOME/.local/share/opencode-unguarded/profile/data/opencode/durable.txt" ] ||
  fail "durable profile data was removed"
[ "$(cat "$HOME/stock.txt")" = "stock" ] || fail "unrelated files were modified"
if kill -0 "$server" 2>/dev/null; then fail "service survived uninstall"; fi
pass "uninstall removed the program and kept profile data"

echo "acceptance: all packaged checks passed"
