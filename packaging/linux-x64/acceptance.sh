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
  for pid in "${server:-}" "${model:-}"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
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
profile="$HOME/.local/share/opencode-unguarded/profile"
mkdir -p "$profile/data/opencode"
echo durable >"$profile/data/opencode/durable.txt"
# Snapshot paths, types, modes, link targets, and content, so a created empty
# directory or a chmod cannot pass unnoticed.
snapshot() {
  find "$1" -mindepth 0 -printf '%p %y %m %l\n' 2>/dev/null | sort
  find "$1" -type f -exec sha256sum {} + 2>/dev/null | sort
}
before="$(snapshot "$profile")"
"$command" uninstall --dry-run >"$work/dry.log" 2>&1 || { cat "$work/dry.log" >&2; fail "dry run failed"; }
[ "$before" = "$(snapshot "$profile")" ] || fail "dry run modified the profile"
pass "dry run left the profile unchanged"

# A dry run must also not create a profile that does not exist yet.
absent="$work/absent-profile"
OPENCODE_UNGUARDED_PROFILE="$absent" "$command" uninstall --dry-run >"$work/dry2.log" 2>&1 ||
  { cat "$work/dry2.log" >&2; fail "dry run with a missing profile failed"; }
[ ! -e "$absent" ] || fail "dry run created a profile that did not exist"
pass "dry run did not create a missing profile"

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
expected="harness-tool-output-$RANDOM$RANDOM"
printf '%s' "$expected" >"$work/model.expected"
PORTFILE="$model_port_file" EXPECTED_FILE="$work/model.expected" bun "$script_dir/model-stub.ts" >"$work/model.log" 2>&1 &
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
printf '%s\n' "$expected" >"$work/project/harness-target.txt"
# The session uses the managed daemon discovered from the registration this
# install wrote, so managed attachment is exercised rather than bypassed.
url="$(jq -r .url "$registration")"
password="$(jq -r .password "$registration")"
(cd "$work/project" && OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_PASSWORD="$password" \
  "$command" run --server "$url" --auto --model harness/stub \
  "Read harness-target.txt with the read tool." >"$work/session.log" 2>&1) ||
  { cat "$work/session.log" >&2; fail "session did not complete"; }
grep -q "$expected" "$work/session.log" ||
  { cat "$work/session.log" >&2; fail "session did not execute the read tool"; }
pass "managed session completed with a packaged install and a real tool call"

# --- negative lifecycle and removal cases ------------------------------------
pass "checking refusals preserve the installation and profile"
# A second installation sharing the same profile must not be able to stop the
# first one's service.
other="$work/other-home"
mkdir -p "$other"
HOME="$other" OPENCODE_UNGUARDED_PROFILE="$profile" "$package/install.sh" --archive "$archive" --no-link \
  >"$work/other-install.log" 2>&1 ||
  { cat "$work/other-install.log" >&2; fail "second installation failed"; }
# Same profile, different installation: this must not be able to stop the
# daemon the first installation owns.
if HOME="$other" OPENCODE_UNGUARDED_PROFILE="$profile" \
  "$other/.local/opt/opencode-unguarded/bin/opencode-unguarded" service stop >"$work/cross.log" 2>&1; then
  fail "another installation stopped this profile's service"
fi
grep -qi "installation\|refus" "$work/cross.log" ||
  { cat "$work/cross.log" >&2; fail "cross-installation refusal was not explained"; }
kill -0 "$server" 2>/dev/null || fail "the original service died during the cross-installation attempt"
jq -e --arg id "$(jq -r .installationId "$prefix/BUILD-INFO.json")" '.installation == $id' "$registration" >/dev/null ||
  fail "the original registration was replaced"
pass "cross-installation stop was refused and the owner survived"

# A malformed registration must stop removal rather than being read as "no service".
cp "$registration" "$work/registration.backup"
jq '.password = 123' "$work/registration.backup" >"$registration"
if "$command" uninstall --force >"$work/badreg.log" 2>&1; then
  fail "uninstall accepted an invalid registration"
fi
[ -d "$prefix" ] || fail "uninstall removed the program after refusing a bad registration"
cp "$work/registration.backup" "$registration"
pass "malformed registration refused removal"

# Tampered metadata must refuse removal.
cp "$prefix/BUILD-INFO.json" "$work/build-info.backup"
jq '.executableSha256 = ("0" * 64)' "$work/build-info.backup" >"$prefix/BUILD-INFO.json"
if "$command" uninstall --force >"$work/tampered.log" 2>&1; then
  fail "uninstall accepted tampered metadata"
fi
[ -x "$prefix/libexec/opencode" ] || fail "uninstall removed a tampered installation"
cp "$work/build-info.backup" "$prefix/BUILD-INFO.json"
pass "tampered executable hash refused removal"

# An unowned file inside the installation must stop recursive removal.
echo keep >"$prefix/unrelated.txt"
if "$command" uninstall --force >"$work/unowned.log" 2>&1; then
  fail "uninstall deleted an installation containing unrelated files"
fi
[ -f "$prefix/unrelated.txt" ] || fail "unrelated file was deleted"
rm -f "$prefix/unrelated.txt"
pass "unrelated installation contents preserved"

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
