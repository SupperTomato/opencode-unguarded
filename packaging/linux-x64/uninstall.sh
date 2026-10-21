#!/usr/bin/env bash
# Remove an opencode-unguarded installation and keep its profile data.
#
# Usage: uninstall.sh [--prefix DIR] [--profile DIR] [--dry-run] [--force]
#
# Only the program directory and the command link that points at it are removed.
# Sessions, credentials, configuration, and other profile data are never
# touched. Ownership is proven by the installation's own metadata and executable;
# stopping the service is delegated to the installation being removed, not to
# whichever `opencode-unguarded` happens to be first on PATH.
set -euo pipefail

die() {
  echo "uninstall.sh: $*" >&2
  exit 1
}

prefix="${OPENCODE_UNGUARDED_INSTALL:-$HOME/.local/opt/opencode-unguarded}"
profile="${OPENCODE_UNGUARDED_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile}"
dry=0
force=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; prefix="$2"; shift 2 ;;
    --profile) [ $# -ge 2 ] || die "--profile needs a value"; profile="$2"; shift 2 ;;
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
case "$profile" in
  /*) ;;
  *) die "--profile must be an absolute path (got: $profile)" ;;
esac

[ -d "$prefix" ] || die "no installation at $prefix"
[ -f "$prefix/BUILD-INFO.json" ] || die "$prefix is not an opencode-unguarded installation"
[ "$(jq -r .derivative "$prefix/BUILD-INFO.json" 2>/dev/null)" = "opencode-unguarded" ] ||
  die "$prefix is not an opencode-unguarded installation"
[ -x "$prefix/libexec/opencode" ] || die "$prefix is missing libexec/opencode"
[ -x "$prefix/bin/opencode-unguarded" ] || die "$prefix is missing bin/opencode-unguarded"

prefix_real="$(cd -P "$prefix" && pwd)"

# A profile path that does not exist is compared lexically after normalization;
# a missing profile must not be created just to be compared.
if [ -d "$profile" ]; then
  profile_real="$(cd -P "$profile" && pwd)"
else
  profile_real="$(realpath -m -- "$profile")"
fi

case "$prefix_real" in
  "$HOME/.local/share/opencode"|"$HOME/.local/share/opencode/"*) die "refusing to remove stock application storage" ;;
  /) die "refusing to remove the filesystem root" ;;
esac
# An installation that contains (or is inside) the profile cannot be removed
# without destroying durable data, so refuse in both directions.
case "$profile_real" in
  "$prefix_real"|"$prefix_real/"*) die "refusing to remove $prefix_real: it contains the application profile $profile_real" ;;
esac
case "$prefix_real" in
  "$profile_real"/*) die "refusing to remove $prefix_real: it is inside the application profile $profile_real" ;;
esac

link="$HOME/.local/bin/opencode-unguarded"
owned_link=0
if [ -L "$link" ]; then
  target="$(readlink "$link")"
  case "$target" in
    "$prefix_real"/bin/opencode-unguarded|"$prefix"/bin/opencode-unguarded) owned_link=1 ;;
  esac
fi

echo "Removing installation: $prefix_real"
echo "Keeping profile data:  $profile_real"
[ "$owned_link" -eq 1 ] && echo "Removing command link: $link"

if [ "$dry" -eq 1 ]; then
  echo "Dry run - no changes made"
  exit 0
fi

if [ "$force" -ne 1 ]; then
  printf 'Remove %s? [y/N] ' "$prefix_real"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Cancelled"; exit 0 ;;
  esac
fi

# Delegate removal to the exact installation being removed. It verifies that the
# running executable belongs to that root, stops only a service it can prove it
# owns, and reports failure instead of force-deleting.
if ! OPENCODE_UNGUARDED_PROFILE="$profile_real" "$prefix_real/bin/opencode-unguarded" uninstall --force >/dev/null 2>&1; then
  echo "uninstall.sh: the installation's own uninstall failed; nothing was removed" >&2
  echo "uninstall.sh: run it directly to see why:" >&2
  echo "  OPENCODE_UNGUARDED_PROFILE='$profile_real' '$prefix_real/bin/opencode-unguarded' uninstall --force" >&2
  exit 1
fi

if [ ! -e "$prefix_real" ]; then
  echo "Uninstalled opencode-unguarded"
  echo "Profile data kept at: $profile_real"
  exit 0
fi

die "the installation still exists after its own uninstall; refusing to delete it directly"
