#!/usr/bin/env sh
# Build the project twice from two clean copies of the working tree and check
# that dist/lnd-sweeper.html is byte-for-byte identical and free of dev-only code.
#
# Usage: scripts/verify-reproducible.sh
# Exit 0 if identical, 1 otherwise. Prints the SHA-256 of the artefact.
#
# Copies the working tree (tracked and untracked files) so it also works
# before a commit. node_modules, dist and .git are not copied; each copy
# installs from the lockfile so the check covers the install step as well.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lnd-sweeper-repro.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

export NODE_ENV=production
export SOURCE_DATE_EPOCH=1
export TZ=UTC
export LANG=C
export LC_ALL=C

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

copy_tree() {
  mkdir -p "$1"
  (cd "$ROOT" && tar --exclude=./node_modules --exclude=./dist --exclude=./.git \
      --exclude=./coverage --exclude=./.e2e-data -cf - .) | (cd "$1" && tar -xf -)
}

build_in() {
  dir="$1"
  copy_tree "$dir"
  (
    cd "$dir"
    pnpm install --frozen-lockfile --prefer-offline --silent
    pnpm build --logLevel warn
  )
  if [ ! -f "$dir/dist/lnd-sweeper.html" ]; then
    echo "FAIL: $dir did not produce dist/lnd-sweeper.html" >&2
    exit 1
  fi
  extra="$(cd "$dir/dist" && find . -type f ! -name lnd-sweeper.html)"
  if [ -n "$extra" ]; then
    echo "FAIL: dist contains files other than lnd-sweeper.html:" >&2
    echo "$extra" >&2
    exit 1
  fi
}

echo "Build 1 in $WORK/a"
build_in "$WORK/a"
echo "Build 2 in $WORK/b"
build_in "$WORK/b"

OUT="$WORK/a/dist/lnd-sweeper.html"
A="$(sha256 "$OUT")"
B="$(sha256 "$WORK/b/dist/lnd-sweeper.html")"

if ! cmp -s "$OUT" "$WORK/b/dist/lnd-sweeper.html"; then
  echo "FAIL: builds differ" >&2
  echo "  a: $A" >&2
  echo "  b: $B" >&2
  exit 1
fi
echo "OK: both builds identical"

# Leak checks: an absolute path or the build user's name in the output means
# something is not reproducible across machines even if two local runs agree.
if grep -q -e "$ROOT" -e "$WORK" -e "${HOME:-/nonexistent}" "$OUT"; then
  echo "FAIL: output contains a local filesystem path" >&2
  exit 1
fi

# Dev-mock guard: src/ui/mock.ts must never reach the artefact. It is only
# reachable behind import.meta.env.DEV, which a NODE_ENV=development build keeps
# alive. Look for its exported symbol and one of its canned error strings.
for needle in "mockPorts" "min relay fee not met, 110 < 141"; do
  if grep -q -F -e "$needle" "$OUT"; then
    echo "FAIL: output contains dev mock code (found \"$needle\")" >&2
    exit 1
  fi
done
echo "OK: no local paths, no dev mock"
echo "SHA-256: $A"
