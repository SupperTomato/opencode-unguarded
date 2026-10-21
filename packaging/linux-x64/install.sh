#!/usr/bin/env bash
# Install or replace an opencode-unguarded archive without touching stock OpenCode.
#
# Usage: install.sh [--prefix DIR] [--no-link] [--archive FILE]
#
# Verification and link preflight finish before the previous installation is
# touched. Activation is a rename; a failed activation restores the previous
# installation.
set -euo pipefail

die() {
  echo "install.sh: $*" >&2
  exit 1
}

archive=""
prefix="${OPENCODE_UNGUARDED_INSTALL:-$HOME/.local/opt/opencode-unguarded}"
link=1
script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; prefix="$2"; shift 2 ;;
    --archive) [ $# -ge 2 ] || die "--archive needs a value"; archive="$2"; shift 2 ;;
    --no-link) link=0; shift ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$prefix" in
  /*) ;;
  *) die "--prefix must be an absolute path (got: $prefix)" ;;
esac

# Refuse installation inside stock application storage or beside the stock binary.
case "$prefix" in
  "$HOME/.local/share/opencode"|"$HOME/.local/share/opencode/"*) die "refusing stock data directory: $prefix" ;;
  "$HOME/.local/bin") die "use the default prefix; --prefix must be an installation directory, not a bin directory" ;;
esac

canonical_allow_missing() {
  local target="$1" suffix=""
  while [ ! -e "$target" ]; do
    suffix="/$(basename "$target")$suffix"
    target="$(dirname "$target")"
  done
  printf '%s%s' "$(cd -P "$target" && pwd)" "$suffix"
}

prefix_real="$(canonical_allow_missing "$prefix")"
case "$prefix_real" in
  "$HOME/.local/share/opencode"|"$HOME/.local/share/opencode/"*)
    die "refusing an installation inside stock OpenCode data: $prefix_real" ;;
  /) die "refusing the filesystem root as an installation" ;;
esac
# An installation that contains the profile cannot be removed without deleting
# the profile, so refuse it up front instead of discovering that at uninstall.
profile_real="$(canonical_allow_missing "${OPENCODE_UNGUARDED_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile}")"
case "$profile_real" in
  "$prefix_real"|"$prefix_real/"*)
    die "refusing an installation root containing the application profile: $profile_real" ;;
esac

work="$(mktemp -d)"
staging=""
cleanup() {
  [ -n "$staging" ] && rm -rf "$staging" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ -z "$archive" ]; then
  archive="$script_dir/../opencode-unguarded-linux-x64.tar.gz"
  [ -f "$archive" ] || archive="$script_dir/opencode-unguarded-linux-x64.tar.gz"
fi
[ -f "$archive" ] || die "archive not found: $archive"
archive_dir="$(cd -P "$(dirname "$archive")" && pwd)"
archive="$(cd -P "$archive_dir" && pwd)/$(basename "$archive")"

# The checksum file is mandatory, and it must cover this exact archive by name.
checksums="$archive_dir/checksums.sha256"
[ -f "$checksums" ] || die "missing $checksums; refusing to install an unverified archive"
archive_name="$(basename "$archive")"
expected="$(awk -v name="$archive_name" '{ file=$2; sub(/^\*/, "", file); n=split(file, parts, "/"); if (parts[n] == name) { print $1; exit } }' "$checksums")"
[ -n "$expected" ] || die "$checksums has no entry for $archive_name; refusing to install an unverified archive"
actual="$(sha256sum "$archive" | cut -d' ' -f1)"
[ "$actual" = "$expected" ] || die "archive checksum failed"

# Reject escaping archive members before extraction.
if tar tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die "archive contains an absolute or traversing path"
fi
if tar tzvf "$archive" | grep -Eq '^l' ; then
  die "archive contains symbolic links; refusing to extract"
fi

mkdir -p "$work/extract"
tar xzf "$archive" -C "$work/extract"
source="$work/extract/opencode-unguarded"
[ -x "$source/libexec/opencode" ] || die "archive is missing libexec/opencode"
[ -x "$source/bin/opencode-unguarded" ] || die "archive is missing bin/opencode-unguarded"

# The archive must match the identity it records before anything runs.
info="$source/BUILD-INFO.json"
[ -f "$info" ] || die "archive is missing BUILD-INFO.json"
version="$(jq -r .version "$info")"
revision="$(jq -r .derivativeRevision "$info")"
[ "$(jq -r .derivative "$info")" = "opencode-unguarded" ] || die "archive metadata is not opencode-unguarded"
[ -n "$version" ] && [ "$version" != "null" ] || die "archive metadata has no version"
[ -n "$revision" ] && [ "$revision" != "null" ] || die "archive metadata has no derivative revision"
recorded_executable="$(jq -r .executableSha256 "$info")"
recorded_launcher="$(jq -r .launcherSha256 "$info")"
if [ -n "$recorded_executable" ] && [ "$recorded_executable" != "null" ]; then
  test "$(sha256sum "$source/libexec/opencode" | cut -d' ' -f1)" = "$recorded_executable" ||
    die "executable hash does not match BUILD-INFO.json"
fi
if [ -n "$recorded_launcher" ] && [ "$recorded_launcher" != "null" ]; then
  test "$(sha256sum "$source/bin/opencode-unguarded" | cut -d' ' -f1)" = "$recorded_launcher" ||
    die "launcher hash does not match BUILD-INFO.json"
fi
reported="$(OPENCODE_UNGUARDED_PROFILE="$work/profile" "$source/bin/opencode-unguarded" --version)"
case "$reported" in
  *"v${version}-unguarded.${revision}"*) ;;
  *) die "embedded version '$reported' does not match metadata 'v${version}-unguarded.${revision}'" ;;
esac

# Preflight the command link before activating anything.
bindir="$HOME/.local/bin"
target="$prefix_real/bin/opencode-unguarded"
current="$bindir/opencode-unguarded"
if [ "$link" -eq 1 ] && [ -L "$current" ]; then
  existing="$(readlink "$current")"
  case "$existing" in
    "$prefix"/*|"$prefix_real"/*) ;;
    *) die "$current points at $existing; refusing to replace a link outside this installation" ;;
  esac
fi
if [ "$link" -eq 1 ] && [ -e "$current" ] && [ ! -L "$current" ]; then
  die "$current exists and is not a symlink; refusing to replace it"
fi

previous=""
mkdir -p "$(dirname "$prefix_real")"
staging="$(dirname "$prefix_real")/.opencode-unguarded.stage.$$"
rm -rf "$staging"
mkdir -p "$staging"
cp -a "$source/." "$staging/"

previous=""
if [ -e "$prefix_real" ]; then
  previous="$(dirname "$prefix_real")/.opencode-unguarded.previous.$$"
  rm -rf "$previous"
  mv "$prefix_real" "$previous"
fi

if ! mv "$staging" "$prefix_real"; then
  if [ -n "$previous" ]; then mv "$previous" "$prefix_real" 2>/dev/null || true; fi
  die "failed to activate the installation; the previous installation was restored"
fi
staging=""

# If anything after activation fails, put the previous installation back.
rollback() {
  rm -rf "$prefix_real" 2>/dev/null || true
  if [ -n "$previous" ]; then mv "$previous" "$prefix_real" 2>/dev/null || true; fi
}

if ! OPENCODE_UNGUARDED_PROFILE="$work/profile" "$prefix_real/bin/opencode-unguarded" --version >/dev/null; then
  rollback
  die "the activated installation failed to run; the previous installation was restored"
fi

if [ "$link" -eq 1 ]; then
  mkdir -p "$bindir"
  if ! ln -sfn "$prefix_real/bin/opencode-unguarded" "$current"; then
    rollback
    die "failed to create $current; the previous installation was restored"
  fi
  echo "install.sh: linked $current -> $prefix_real/bin/opencode-unguarded"
fi

if [ -n "$previous" ]; then
  echo "install.sh: previous installation kept at $previous"
  echo "install.sh: remove it with: rm -rf '$previous'"
fi

echo "install.sh: installed $reported to $prefix_real"
echo "install.sh: profile data lives at ${OPENCODE_UNGUARDED_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile}"
