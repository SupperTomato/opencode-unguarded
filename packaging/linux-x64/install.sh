#!/usr/bin/env bash
# Install or replace an opencode-unguarded archive without touching stock OpenCode.
#
# Usage: install.sh [--prefix DIR] [--no-link] [--archive FILE]
#
# Verification and link preflight finish before the previous installation is
# touched. Activation is a rename; every failure after that point restores the
# previous program and command link.
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
  # Walk to the nearest existing directory, so an existing regular file (such as
  # an initialised database or a stray bin entry) is never mistaken for a
  # directory.
  local target="$1" suffix=""
  while [ ! -d "$target" ]; do
    [ "$target" = "/" ] && break
    suffix="/$(basename "$target")$suffix"
    target="$(dirname "$target")"
  done
  printf '%s%s' "$(cd -P "$target" && pwd)" "$suffix"
}

prefix_real="$(canonical_allow_missing "$prefix")"
case "$prefix_real" in
  "$HOME/.local/share/opencode"|"$HOME/.local/share/opencode/"*)
    die "refusing an installation inside stock OpenCode data: $prefix_real" ;;
  "$HOME/.config/opencode"|"$HOME/.config/opencode/"*)
    die "refusing an installation inside stock OpenCode config: $prefix_real" ;;
  /) die "refusing the filesystem root as an installation" ;;
esac
profile_real="$(canonical_allow_missing "${OPENCODE_UNGUARDED_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile}")"
case "$profile_real" in
  "$prefix_real"|"$prefix_real/"*)
    die "refusing an installation root containing the application profile: $profile_real" ;;
esac

# An existing installation is only replaceable when it is actually ours. Refuse
# to rename an unrelated directory out of the way.
if [ -e "$prefix_real" ]; then
  [ -d "$prefix_real" ] || die "$prefix_real exists and is not a directory"
  [ -f "$prefix_real/BUILD-INFO.json" ] ||
    die "$prefix_real exists but has no BUILD-INFO.json; refusing to replace an unrelated directory"
  [ "$(jq -r .derivative "$prefix_real/BUILD-INFO.json" 2>/dev/null)" = "opencode-unguarded" ] ||
    die "$prefix_real is not an opencode-unguarded installation; refusing to replace it"
fi

work="$(mktemp -d)"
staging=""
previous=""
link_created=0
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

# The checksum file is mandatory and must contain exactly one valid entry for
# this exact archive. Accepting an ambiguous or unrelated checksum would let a
# package be installed without a verified digest.
checksums="$archive_dir/checksums.sha256"
[ -f "$checksums" ] || die "missing $checksums; refusing to install an unverified archive"
archive_name="$(basename "$archive")"
entries="$(awk -v name="$archive_name" '
  { file=$2; sub(/^\*/, "", file); n=split(file, parts, "/"); if (parts[n] == name) print $1 }
' "$checksums")"
count="$(printf '%s\n' "$entries" | grep -c '^[0-9a-f]\{64\}$' || true)"
[ "$count" -eq 1 ] || die "$checksums must contain exactly one 64-character digest for $archive_name (found $count)"
expected="$entries"
actual="$(sha256sum "$archive" | cut -d' ' -f1)"
[ "$actual" = "$expected" ] || die "archive checksum failed"

# Reject escaping, linked, or special archive members before extraction.
listing="$(tar tzf "$archive")" || die "archive cannot be listed"
if printf '%s\n' "$listing" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die "archive contains an absolute or traversing path"
fi
verbose="$(tar tzvf "$archive")" || die "archive cannot be inspected"
if printf '%s\n' "$verbose" | grep -Eq '^[lhcbps]'; then
  die "archive contains a symbolic link, hard link, or special file; refusing to extract"
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
# The recorded hashes are mandatory: a package that does not state them cannot
# be verified, so it is not installed.
recorded_executable="$(jq -r .executableSha256 "$info")"
recorded_launcher="$(jq -r .launcherSha256 "$info")"
case "$recorded_executable" in
  [0-9a-f]*) ;;
  *) die "BUILD-INFO.json has no executableSha256; refusing an unverified package" ;;
esac
case "$recorded_launcher" in
  [0-9a-f]*) ;;
  *) die "BUILD-INFO.json has no launcherSha256; refusing an unverified package" ;;
esac
[ "${#recorded_executable}" -eq 64 ] || die "BUILD-INFO.json executableSha256 is malformed"
[ "${#recorded_launcher}" -eq 64 ] || die "BUILD-INFO.json launcherSha256 is malformed"
test "$(sha256sum "$source/libexec/opencode" | cut -d' ' -f1)" = "$recorded_executable" ||
  die "executable hash does not match BUILD-INFO.json"
test "$(sha256sum "$source/bin/opencode-unguarded" | cut -d' ' -f1)" = "$recorded_launcher" ||
  die "launcher hash does not match BUILD-INFO.json"
reported="$(OPENCODE_UNGUARDED_PROFILE="$work/profile" "$source/bin/opencode-unguarded" --version)" ||
  die "the packaged launcher failed to run"
case "$reported" in
  *"v${version}-unguarded.${revision}"*) ;;
  *) die "embedded version '$reported' does not match metadata 'v${version}-unguarded.${revision}'" ;;
esac

# Installation identity distinguishes two installations that share a profile.
# Replacing an installation keeps its identity; a new one gets a fresh id.
installation_id=""
if [ -f "$prefix_real/BUILD-INFO.json" ]; then
  installation_id="$(jq -r '.installationId // empty' "$prefix_real/BUILD-INFO.json" 2>/dev/null || true)"
fi
if [ -z "$installation_id" ]; then
  installation_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
fi
jq --arg id "$installation_id" '. + {installationId: $id}' "$info" > "$source/BUILD-INFO.json.new" ||
  die "failed to record the installation identity"
mv "$source/BUILD-INFO.json.new" "$source/BUILD-INFO.json"

# Preflight the command link before activating anything.
bindir="$HOME/.local/bin"
target="$prefix_real/bin/opencode-unguarded"
current="$bindir/opencode-unguarded"
if [ "$link" -eq 1 ]; then
  # The command directory itself must be usable: mkdir fails if it is a regular
  # file, and that must be discovered before the previous installation moves.
  if [ -e "$bindir" ] && [ ! -d "$bindir" ]; then
    die "$bindir exists and is not a directory; refusing to activate an installation with no usable command link"
  fi
  if [ -L "$current" ]; then
    existing="$(readlink "$current")"
    case "$existing" in
      "$target"|"$prefix_real"/bin/opencode-unguarded|"$prefix"/bin/opencode-unguarded) ;;
      *) die "$current points at $existing; refusing to replace a link outside this installation" ;;
    esac
  elif [ -e "$current" ]; then
    die "$current exists and is not a symlink; refusing to replace it"
  fi
fi

mkdir -p "$(dirname "$prefix_real")"
staging="$(dirname "$prefix_real")/.opencode-unguarded.stage.$$"
rm -rf "$staging"
mkdir -p "$staging"
cp -a "$source/." "$staging/"

previous=""
before_link="/nonexistent"
if [ -e "$prefix_real" ]; then
  previous="$(dirname "$prefix_real")/.opencode-unguarded.previous.$$"
  rm -rf "$previous"
  mv "$prefix_real" "$previous"
fi
if [ -L "$current" ]; then
  before_link="$(readlink "$current")"
fi

# Restore the previous program and command link. Success is required for the
# failure message to claim a rollback, so the caller verifies afterwards.
rollback() {
  rm -rf "$prefix_real" 2>/dev/null || true
  if [ -n "$previous" ]; then mv "$previous" "$prefix_real" 2>/dev/null || true; fi
  if [ "$link_created" -eq 1 ]; then
    if [ "$before_link" = "/nonexistent" ]; then
      rm -f "$current" 2>/dev/null || true
    else
      ln -sfn "$before_link" "$current" 2>/dev/null || true
    fi
  fi
}

fail_activated() {
  local message="$1"
  rollback
  if [ -n "$previous" ] && [ -e "$prefix_real" ] && [ ! -e "$previous" ]; then
    die "$message; the previous installation was restored"
  fi
  if [ -z "$previous" ] && [ ! -e "$prefix_real" ]; then
    die "$message; nothing was installed"
  fi
  die "$message; rollback FAILED - inspect $prefix_real and $previous"
}

if ! mv "$staging" "$prefix_real"; then
  rollback
  die "failed to activate the installation"
fi
staging=""

if ! OPENCODE_UNGUARDED_PROFILE="$work/profile" "$prefix_real/bin/opencode-unguarded" --version >/dev/null; then
  fail_activated "the activated installation failed to run"
fi

if [ "$link" -eq 1 ]; then
  mkdir -p "$bindir" || fail_activated "failed to create $bindir"
  ln -sfn "$prefix_real/bin/opencode-unguarded" "$current" ||
    fail_activated "failed to create $current"
  link_created=1
  [ "$(readlink "$current")" = "$prefix_real/bin/opencode-unguarded" ] ||
    fail_activated "$current does not point at the new installation"
fi

if [ -n "$previous" ]; then
  echo "install.sh: previous installation kept at $previous"
  echo "install.sh: remove it with: rm -rf '$previous'"
fi

echo "install.sh: installed $reported to $prefix_real"
echo "install.sh: profile data lives at ${OPENCODE_UNGUARDED_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile}"
