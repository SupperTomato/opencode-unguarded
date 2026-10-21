#!/usr/bin/env bash
# Install or replace an opencode-unguarded archive without touching stock OpenCode.
#
# Usage: install.sh [--prefix DIR] [--no-link] [--archive FILE]
#
# The archive is verified against its checksum, staged beside the target, and
# activated by rename. The previous installation is kept as a rollback copy.
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

checksums="$(dirname "$archive")/checksums.sha256"
if [ -f "$checksums" ]; then
  (cd "$(dirname "$archive")" && sha256sum -c checksums.sha256 >/dev/null) || die "archive checksum failed"
else
  echo "install.sh: warning: no checksums.sha256 beside the archive; skipping checksum verification" >&2
fi

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

# Activate only a binary whose embedded revision matches its metadata.
info="$source/BUILD-INFO.json"
[ -f "$info" ] || die "archive is missing BUILD-INFO.json"
reported="$("$source/bin/opencode-unguarded" --version)"
recorded="v$(jq -r .version "$info")-unguarded.$(jq -r .derivativeRevision "$info")"
case "$reported" in
  *"$recorded"*) ;;
  *) die "embedded version '$reported' does not match metadata '$recorded'" ;;
esac

mkdir -p "$(dirname "$prefix")"
staging="$(dirname "$prefix")/.opencode-unguarded.stage.$$"
rm -rf "$staging"
mkdir -p "$staging"
cp -a "$source/." "$staging/"

previous=""
if [ -e "$prefix" ]; then
  previous="$(dirname "$prefix")/.opencode-unguarded.previous.$$"
  rm -rf "$previous"
  mv "$prefix" "$previous"
fi

if ! mv "$staging" "$prefix"; then
  [ -n "$previous" ] && mv "$previous" "$prefix" 2>/dev/null || true
  die "failed to activate the installation; the previous installation was restored"
fi
staging=""

if [ -n "$previous" ]; then
  echo "install.sh: previous installation kept at $previous"
  echo "install.sh: remove it with: rm -rf '$previous'"
fi

if [ "$link" -eq 1 ]; then
  bindir="$HOME/.local/bin"
  mkdir -p "$bindir"
  target="$prefix/bin/opencode-unguarded"
  current="$bindir/opencode-unguarded"
  if [ -e "$current" ] && [ ! -L "$current" ]; then
    die "$current exists and is not a symlink; refusing to replace it"
  fi
  if [ -L "$current" ]; then
    existing="$(readlink "$current")"
    case "$existing" in
      "$prefix"/*|*opencode-unguarded*) ;;
      *) die "$current points at $existing; refusing to replace an unrelated command" ;;
    esac
  fi
  ln -sfn "$target" "$current"
  echo "install.sh: linked $current -> $target"
fi

"$prefix/bin/opencode-unguarded" --version
echo "install.sh: installed to $prefix"
echo "install.sh: profile data lives at ${OPENCODE_UNGUARDED_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile}"
