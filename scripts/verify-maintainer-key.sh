#!/usr/bin/env sh
# Check the maintainer signing keys in keys/ against scripts/maintainer-keys.sh:
# every listed file parses with gpg, holds exactly one public key whose primary
# fingerprint and uid email match the list, every fingerprint appears (spaced)
# in README.md, SECURITY.md, CONTRIBUTING.md and keys/README.md, and keys/
# contains no key files that are not listed. Run in CI.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/maintainer-keys.sh"
DOCS="README.md SECURITY.md CONTRIBUTING.md keys/README.md"

command -v gpg >/dev/null 2>&1 || { echo "gpg is required" >&2; exit 2; }

fail=0
for fpr in $(maintainer_fprs); do
  file="$(maintainer_file_for "$fpr")"
  email="$(maintainer_email_for "$fpr")"
  key="$ROOT/keys/$file"
  echo "== $file"
  if [ ! -f "$key" ]; then echo "  FAIL: missing" >&2; fail=1; continue; fi

  T="$(mktemp -d "${TMPDIR:-/tmp}/lnd-sweeper-key.XXXXXX")"
  chmod 700 "$T"
  if ! GNUPGHOME="$T" gpg --batch --quiet --import "$key" 2>/dev/null; then
    echo "  FAIL: gpg could not import" >&2; fail=1; rm -rf "$T"; continue
  fi
  cols="$(GNUPGHOME="$T" gpg --batch --with-colons --list-keys 2>/dev/null)"
  rm -rf "$T"
  npub="$(printf '%s\n' "$cols" | grep -c '^pub:' || true)"
  have="$(printf '%s\n' "$cols" | awk -F: '/^pub:/{p=1;next} p&&/^fpr:/{print $10; exit}')"
  if [ "$npub" -ne 1 ]; then echo "  FAIL: expected exactly one public key, found $npub" >&2; fail=1; fi
  if [ "$have" != "$fpr" ]; then echo "  FAIL: fingerprint $have, expected $fpr" >&2; fail=1; else echo "  fingerprint OK: $(spaced_fpr "$fpr")"; fi
  if printf '%s\n' "$cols" | grep '^uid:' | grep -q -F "<$email>"; then echo "  uid OK: $email"; else echo "  FAIL: no uid <$email>" >&2; fail=1; fi

  spaced="$(spaced_fpr "$fpr")"
  for d in $DOCS; do
    if grep -q -F "$spaced" "$ROOT/$d"; then echo "  $d: OK"; else echo "  $d: FAIL, fingerprint not found" >&2; fail=1; fi
  done
done

echo "== keys/ contains only listed files"
for f in "$ROOT"/keys/*; do
  b="$(basename "$f")"
  [ "$b" = "README.md" ] && continue
  if maintainer_files | grep -q -x -F "$b"; then echo "  $b: listed"; else echo "  $b: FAIL, not in scripts/maintainer-keys.sh" >&2; fail=1; fi
done

[ "$fail" -eq 0 ] || exit 1
echo "OK: maintainer keys and documents agree"
