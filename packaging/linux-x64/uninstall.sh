#!/usr/bin/env bash
# Remove an opencode-unguarded installation and keep its profile data.
#
# Usage: uninstall.sh [--prefix DIR] [--purge-profile] [--dry-run] [--force]
set -euo pipefail

die() {
  echo "uninstall.sh: $*" >&2
  exit 1
}

prefix="${OPENCODE_UNGUARDED_INSTALL:-$HOME/.local/opt/opencode-unguarded}"
profile="${OPENCODE_UNGUARDED_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile}"
purge=0
dry=0
force=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; prefix="$2"; shift 2 ;;
    --profile) [ $# -ge 2 ] || die "--profile needs a value"; profile="$2"; shift 2 ;;
    --purge-profile) purge=1; shift ;;
    --dry-run) dry=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$prefix" in
  /*) ;;
  *) die "--prefix must be an absolute path (got: $prefix)" ;;
esac

[ -d "$prefix" ] || die "no installation at $prefix"
[ -x "$prefix/libexec/opencode" ] || die "$prefix is not an opencode-unguarded installation"
[ -x "$prefix/bin/opencode-unguarded" ] || die "$prefix is not an opencode-unguarded installation"

echo "Removing installation: $prefix"
echo "Keeping profile data:  $profile"

if [ "$dry" -eq 1 ]; then
  echo "Dry run - no changes made"
  exit 0
fi

if [ "$force" -ne 1 ]; then
  printf 'Remove %s? [y/N] ' "$prefix"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Cancelled"; exit 0 ;;
  esac
fi

# Stop only the derivative service, identified by its own registration marker.
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/opencode"
registration="$state_dir/service-unguarded.json"
if [ -f "$registration" ] && command -v opencode-unguarded >/dev/null 2>&1; then
  OPENCODE_UNGUARDED_ROOT="$prefix" opencode-unguarded uninstall --force >/dev/null 2>&1 || true
fi

prefix_real="$(cd -P "$prefix" && pwd)"
case "$prefix_real" in
  "$HOME/.local/share/opencode"|"$HOME/.local/share/opencode/"*) die "refusing to remove stock application storage" ;;
  /) die "refusing to remove the filesystem root" ;;
esac

rm -rf "$prefix_real"

link="$HOME/.local/bin/opencode-unguarded"
if [ -L "$link" ]; then
  target="$(readlink "$link")"
  case "$target" in
    "$prefix_real"/*) rm -f "$link"; echo "Removed command link: $link" ;;
    *) echo "Left $link in place; it points at $target" ;;
  esac
fi

if [ "$purge" -eq 1 ]; then
  case "$profile" in
    /*) ;;
    *) die "--profile must be absolute when purging" ;;
  esac
  case "$profile" in
    "$HOME/.local/share/opencode"|"$HOME/.local/share/opencode/"*) die "refusing to purge stock data" ;;
    /) die "refusing to purge the filesystem root" ;;
  esac
  echo "Purging profile: $profile"
  rm -rf "$profile"
else
  echo "Profile data kept at: $profile"
fi

echo "Uninstalled opencode-unguarded"
