# Sourced by every RELEASE build script (build-windows.sh, build-apk.sh) — never run alone.
# The one owner of "is this tree fit to be labelled a release, and with what label" (#278).
#
# Why it exists: 1.66.12+152 was built from a STALE checkout. Its pubspec said 1.66.9 and
# its vendored xterm predated #237's fix, but the build scripts took the version as
# arguments and passed them to --build-name/--build-number, which OVERRIDE pubspec.yaml.
# So the binary was labelled 1.66.12, installed on every device, and still underlined
# every word. A label that can be typed independently of the source proves nothing.
#
# The rules:
#   1. The version comes ONLY from the tree's pubspec.yaml. No script accepts one, and
#      nothing passes --build-name/--build-number (flutter reads pubspec by default).
#      To ship a new build, bump pubspec.yaml — that is the repo's rule anyway.
#   2. The checkout must CONTAIN origin/master. A branch behind master is missing merged
#      fixes — exactly what shipped #237's bug. `--allow-stale` builds anyway, for a
#      deliberate test build of an old branch; it says so loudly.
#   3. A dirty tree is WARNED about, not refused: the label then names a commit plus
#      edits nobody can recover, which is fine for a probe and wrong for a release.
#
# Caller contract: set SRC (the ai-terminal/ dir), then `source release-preflight.sh "$@"`.
# Sets RELEASE_VERSION. Exits non-zero on any refusal.

_rp_fail() { echo "== REFUSED: $*" >&2; exit 1; }

ALLOW_STALE=0
for _rp_arg in "$@"; do
  case "$_rp_arg" in
    --allow-stale) ALLOW_STALE=1 ;;
    *) _rp_fail "unexpected argument '$_rp_arg'. The version is read from pubspec.yaml — bump it there, do not pass it (#278)." ;;
  esac
done

RELEASE_VERSION="$(sed -n 's/^version:[[:space:]]*//p' "$SRC/pubspec.yaml" | tr -d '\r')"
[ -n "$RELEASE_VERSION" ] || _rp_fail "no 'version:' line in $SRC/pubspec.yaml"

git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 \
  || _rp_fail "$SRC is not in a git checkout, so nothing can say what source this build is"

# Best effort: a stale local origin/master only makes the check weaker, never wrong.
# GIT_TERMINAL_PROMPT=0 so a credential prompt cannot hang the build.
if ! GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$SRC" fetch --quiet origin master 2>/dev/null; then
  echo "== WARNING: could not fetch origin/master; checking against the local copy" >&2
fi

_rp_head="$(git -C "$SRC" rev-parse --short HEAD)"
_rp_branch="$(git -C "$SRC" rev-parse --abbrev-ref HEAD)"
if ! git -C "$SRC" merge-base --is-ancestor origin/master HEAD; then
  _rp_behind="$(git -C "$SRC" rev-list --count HEAD..origin/master)"
  if [ "$ALLOW_STALE" = 1 ]; then
    echo "== WARNING: --allow-stale: $_rp_branch@$_rp_head is missing $_rp_behind commit(s) from origin/master. NOT a release build." >&2
  else
    _rp_fail "$_rp_branch@$_rp_head is missing $_rp_behind commit(s) from origin/master, so merged fixes would be left out. Merge or rebase first, or pass --allow-stale for a deliberate test build."
  fi
fi

if [ -n "$(git -C "$SRC" status --porcelain -- . 2>/dev/null)" ]; then
  echo "== WARNING: uncommitted changes under $SRC — this build is $_rp_head PLUS edits no commit records" >&2
fi

echo "== release $RELEASE_VERSION from $_rp_branch@$_rp_head"
