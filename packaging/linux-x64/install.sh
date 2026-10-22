#!/usr/bin/env bash
# Install or replace an opencode-unguarded archive without touching stock OpenCode.
#
# Usage: install.sh [--prefix DIR] [--no-link] [--archive FILE]
#
# Verification and link preflight finish before the previous installation is
# touched. Activation is a rename; failures after that point restore the
# previous program and command link. A verified previous service is stopped
# before activation and restarted if activation rolls back.
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

# Package layout. Removal and replacement both rely on this inventory: an
# unexpected entry means the directory is not exclusively ours.
owned_files=(
  BUILD-INFO.json
  LICENSE
  THIRD_PARTY_NOTICES.md
  acceptance.sh
  bin/opencode-unguarded
  collector.ts
  install.sh
  libexec/opencode
  model-stub.ts
  telemetry-harness.sh
  uninstall.sh
)
owned_directories=(bin libexec)

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

profile_real="$(canonical_allow_missing "${OPENCODE_UNGUARDED_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile}")"
prefix_real="$(canonical_allow_missing "$prefix")"

# Refuse installation inside stock application storage, beside the stock
# binary, or inside/around the application profile. Both XDG-derived and
# conventional stock locations are protected.
stock_roots() {
  printf '%s\n' \
    "${XDG_DATA_HOME:-$HOME/.local/share}/opencode" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" \
    "${XDG_CACHE_HOME:-$HOME/.cache}/opencode" \
    "${XDG_STATE_HOME:-$HOME/.local/state}/opencode" \
    "$HOME/.local/share/opencode" \
    "$HOME/.config/opencode" \
    "$HOME/.cache/opencode" \
    "$HOME/.local/state/opencode"
}

overlaps() {
  case "$1" in "$2"|"$2"/*) return 0 ;; esac
  case "$2" in "$1"/*) return 0 ;; esac
  return 1
}

[ "$prefix_real" = "/" ] && die "refusing the filesystem root as an installation"
case "$prefix_real" in
  */.local/bin|*/.local/bin/) die "use the default prefix; --prefix must be an installation directory, not a bin directory" ;;
esac
for stock in $(stock_roots); do
  stock_real="$(canonical_allow_missing "$stock")"
  if overlaps "$prefix_real" "$stock" || overlaps "$prefix_real" "$stock_real"; then
    die "refusing an installation inside stock OpenCode storage: $prefix_real"
  fi
done
# The profile must not be inside the installation (durable data would be
# deleted by removal) and the installation must not be inside the profile
# (program files would mix into user storage).
if overlaps "$prefix_real" "$profile_real"; then
  case "$profile_real" in
    "$prefix_real"|"$prefix_real"/*) die "refusing an installation root containing the application profile: $profile_real" ;;
  esac
  case "$prefix_real" in
    "$profile_real"|"$profile_real"/*) die "refusing an installation root inside the application profile: $prefix_real" ;;
  esac
fi

# An existing installation is only replaceable when it is actually ours and
# contains only files this installer writes. A metadata marker alone is a
# claim; the executable and launcher bytes must match it too.
previous_id=""
previous_state=absent
if [ -e "$prefix_real" ] || [ -L "$prefix_real" ]; then
  [ -d "$prefix_real" ] && [ ! -L "$prefix_real" ] || die "$prefix_real exists and is not a directory"
  [ -f "$prefix_real/BUILD-INFO.json" ] ||
    die "$prefix_real exists but has no BUILD-INFO.json; refusing to replace an unrelated directory"
  [ ! -L "$prefix_real/BUILD-INFO.json" ] || die "refusing symlinked installation metadata in $prefix_real"
  [ "$(jq -r .derivative "$prefix_real/BUILD-INFO.json" 2>/dev/null)" = "opencode-unguarded" ] ||
    die "$prefix_real is not an opencode-unguarded installation; refusing to replace it"
  recorded_executable="$(jq -r '.executableSha256 // empty' "$prefix_real/BUILD-INFO.json")"
  recorded_launcher="$(jq -r '.launcherSha256 // empty' "$prefix_real/BUILD-INFO.json")"
  [ -n "$recorded_executable" ] && [ -n "$recorded_launcher" ] ||
    die "$prefix_real records no executable or launcher hash; refusing to replace an unverified directory"
  [ ! -L "$prefix_real/libexec/opencode" ] && [ -f "$prefix_real/libexec/opencode" ] ||
    die "$prefix_real/libexec/opencode is missing or a link"
  [ ! -L "$prefix_real/bin/opencode-unguarded" ] && [ -f "$prefix_real/bin/opencode-unguarded" ] ||
    die "$prefix_real/bin/opencode-unguarded is missing or a link"
  test "$(sha256sum "$prefix_real/libexec/opencode" | cut -d' ' -f1)" = "$recorded_executable" ||
    die "$prefix_real/libexec/opencode does not match its metadata"
  test "$(sha256sum "$prefix_real/bin/opencode-unguarded" | cut -d' ' -f1)" = "$recorded_launcher" ||
    die "$prefix_real/bin/opencode-unguarded does not match its metadata"
  # Every entry under the root must be a file this installer writes: an
  # unrelated file, a link, or a durable data directory means the directory is
  # not exclusively ours, and replacing it would move that data away.
  for entry in $(cd "$prefix_real" && find . -mindepth 1 | sed 's|^\./||'); do
    if [ -L "$prefix_real/$entry" ]; then
      die "refusing to replace $prefix_real: $entry is a symbolic link"
    fi
    if [ -d "$prefix_real/$entry" ]; then
      found=0
      for allowed in "${owned_directories[@]}"; do
        [ "$entry" = "$allowed" ] && found=1
      done
      [ "$found" -eq 1 ] || die "refusing to replace $prefix_real: unexpected directory $entry"
      continue
    fi
    found=0
    for allowed in "${owned_files[@]}"; do
      [ "$entry" = "$allowed" ] && found=1
    done
    [ "$found" -eq 1 ] || die "refusing to replace $prefix_real: unexpected file $entry"
  done
  previous_id="$(jq -r '.installationId // empty' "$prefix_real/BUILD-INFO.json" 2>/dev/null || true)"
  previous_state=present
fi

work="$(mktemp -d)"
staging=""
previous=""
link_created=0
service_stopped=0
committed=0

rollback() {
  [ "$committed" -eq 1 ] && return 0
  rm -rf "$prefix_real" 2>/dev/null || true
  if [ -n "$previous" ]; then
    if ! mv "$previous" "$prefix_real" 2>/dev/null; then
      echo "install.sh: ROLLBACK FAILED - previous installation is at $previous" >&2
      return 1
    fi
    previous=""
  fi
  if [ "$link_created" -eq 1 ]; then
    if [ "$before_link" = "/nonexistent" ]; then
      rm -f "$current" 2>/dev/null || true
    else
      ln -sfn "$before_link" "$current" 2>/dev/null || true
    fi
  fi
  if [ "$service_stopped" -eq 1 ] && [ -x "$prefix_real/bin/opencode-unguarded" ]; then
    OPENCODE_UNGUARDED_PROFILE="$profile_real" "$prefix_real/bin/opencode-unguarded" service start >/dev/null 2>&1 ||
      echo "install.sh: the previous service was stopped and could not be restarted; run 'opencode-unguarded service start'" >&2
  fi
  return 0
}

interrupted() {
  trap - INT TERM HUP
  rollback || true
  [ -n "$staging" ] && rm -rf "$staging" 2>/dev/null || true
  rm -rf "$work"
  exit 130
}

cleanup() {
  [ -n "$staging" ] && rm -rf "$staging" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap interrupted INT TERM HUP

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

# Validate the complete member set before extraction. A duplicate name could
# replace a file after it was inspected, and an unexpected ordinary file would
# be copied into the installation.
listing="$(tar tzf "$archive")" || die "archive cannot be listed"
if printf '%s\n' "$listing" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die "archive contains an absolute or traversing path"
fi
verbose="$(tar tzvf "$archive")" || die "archive cannot be inspected"
if printf '%s\n' "$verbose" | grep -Eq '^[lhcbps]'; then
  die "archive contains a symbolic link, hard link, or special file; refusing to extract"
fi
duplicates="$(printf '%s\n' "$listing" | sort | uniq -d)"
[ -z "$duplicates" ] || die "archive contains duplicate members: $(printf '%s' "$duplicates" | tr '\n' ' ')"
# Required regular files. Directory entries are implied by their children and
# are not compared, since a tar may or may not record them explicitly.
allowed_members="$(printf '%s\n' \
  opencode-unguarded/BUILD-INFO.json \
  opencode-unguarded/LICENSE \
  opencode-unguarded/THIRD_PARTY_NOTICES.md \
  opencode-unguarded/acceptance.sh \
  opencode-unguarded/bin/opencode-unguarded \
  opencode-unguarded/collector.ts \
  opencode-unguarded/install.sh \
  opencode-unguarded/libexec/opencode \
  opencode-unguarded/model-stub.ts \
  opencode-unguarded/telemetry-harness.sh \
  opencode-unguarded/uninstall.sh | sort)"
unexpected_members="$(printf '%s\n' "$listing" | grep -v '/$' | grep -v '^opencode-unguarded$' | sort | comm -23 - <(printf '%s\n' "$allowed_members") || true)"
[ -z "$unexpected_members" ] ||
  die "archive contains members outside the package layout: $(printf '%s' "$unexpected_members" | tr '\n' ' ')"
missing_members="$(printf '%s\n' "$allowed_members" | comm -23 - <(printf '%s\n' "$listing" | grep -v '/$' | sort) || true)"
[ -z "$missing_members" ] ||
  die "archive is missing required members: $(printf '%s' "$missing_members" | tr '\n' ' ')"

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
for recorded in "$recorded_executable" "$recorded_launcher"; do
  printf '%s' "$recorded" | grep -Eq '^[0-9a-f]{64}$' ||
    die "BUILD-INFO.json has a malformed or missing artifact hash; refusing an unverified package"
done
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
installation_id="$previous_id"
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
before_link="/nonexistent"
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

# If an owned previous service is still running, stop it before its program
# files move. It is restarted by rollback if activation fails. A registration
# that belongs to a different installation is left alone and reported: it must
# never be stopped to make this installation possible.
if [ "$previous_state" = present ]; then
  previous_registration="$profile_real/state/opencode/service-unguarded.json"
  if [ -f "$previous_registration" ]; then
    registered_pid="$(jq -r '.pid // empty' "$previous_registration" 2>/dev/null || true)"
    registered_installation="$(jq -r '.installation // empty' "$previous_registration" 2>/dev/null || true)"
    if [ -n "$registered_pid" ] && kill -0 "$registered_pid" 2>/dev/null; then
      if [ -z "$previous_id" ] || [ "$registered_installation" != "$previous_id" ]; then
        die "a service for a different installation is running (pid $registered_pid); stop it or use a separate profile"
      fi
      if ! OPENCODE_UNGUARDED_PROFILE="$profile_real" "$prefix_real/bin/opencode-unguarded" service stop >/dev/null 2>&1; then
        die "the running previous service could not be stopped; stop it with 'opencode-unguarded service stop', then install again"
      fi
      service_stopped=1
    fi
  fi
fi

mkdir -p "$(dirname "$prefix_real")"
# A unique staging directory avoids deleting a path another process guessed.
staging="$(mktemp -d "$(dirname "$prefix_real")/.opencode-unguarded.stage.XXXXXX")"
cp -a "$source/." "$staging/"

previous=""
if [ -e "$prefix_real" ]; then
  previous="$(mktemp -d "$(dirname "$prefix_real")/.opencode-unguarded.previous.XXXXXX")"
  rmdir "$previous" || die "could not allocate a rollback path"
  mv "$prefix_real" "$previous"
fi
if [ -L "$current" ]; then
  before_link="$(readlink "$current")" || die "could not read the existing command link"
fi

fail_activated() {
  local message="$1"
  if rollback; then
    die "$message; the previous state was restored"
  fi
  die "$message; rollback FAILED - inspect $prefix_real and $previous"
}

if ! mv "$staging" "$prefix_real"; then
  fail_activated "failed to activate the installation"
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

committed=1
if [ -n "$previous" ]; then
  echo "install.sh: previous installation kept at $previous"
  echo "install.sh: remove it with: rm -rf '$previous'"
fi

echo "install.sh: installed $reported to $prefix_real"
echo "install.sh: profile data lives at $profile_real"
