#!/usr/bin/env sh
# Maintainer step between the automated draft release and publication.
#
#   scripts/release-sign.sh vX.Y.Z
#
# 1. Downloads SHA256SUMS and lnd-sweeper.html from the draft release.
# 2. Checks the build provenance attestation on the downloaded file and refuses
#    to sign if that fails. SKIP_ATTESTATION=1 overrides with a loud warning.
# 3. Rebuilds locally from the tagged checkout and requires the hash to match.
# 4. Picks the signer: GPG_KEY if set, otherwise whichever allowed maintainer
#    secret key (scripts/maintainer-keys.sh) is in your keyring. Refuses if none
#    or more than one is present without GPG_KEY.
# 5. Follows the Bitcoin Core convention: one SHA256SUMS.asc that may hold
#    several detached signatures. If the draft already has one, it is
#    downloaded and its signatures verified against the allowed set; your
#    signature is appended; the result is re-verified (a VALIDSIG, judged by primary-key fingerprint, for every
#    signature, each from an allowed key, in a throwaway keyring built only
#    from keys/) and uploaded with --clobber.
# 6. Prints the publish command. Never generates a key.
#
# Requires: gh (logged in), pnpm, node (see .nvmrc), gpg with your maintainer
# secret key.
set -eu

TAG="${1:?usage: $0 vX.Y.Z}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/maintainer-keys.sh"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

command -v gpg >/dev/null 2>&1 || { echo "gpg is required" >&2; exit 2; }
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lnd-sweeper-sign.XXXXXX")"
echo "Working in $WORK (kept for inspection)"

# Throwaway keyring holding only the allowed public keys, for all verification.
VHOME="$(mktemp -d "${TMPDIR:-/tmp}/lnd-sweeper-verify.XXXXXX")"
chmod 700 "$VHOME"
trap 'rm -rf "$VHOME"' EXIT INT TERM
for fpr in $(maintainer_fprs); do
  GNUPGHOME="$VHOME" gpg --batch --quiet --import "$ROOT/keys/$(maintainer_file_for "$fpr")" 2>/dev/null
done

# verify_all <sigfile> <datafile>: every signature must be VALIDSIG from an allowed key.
# Prints the signer fingerprints; returns 1 on any bad, unknown or non-allowed signature.
verify_all() {
  gpgout="$(GNUPGHOME="$VHOME" gpg --batch --status-fd 1 --verify "$1" "$2" 2>/dev/null || true)"
  nsig="$(printf '%s\n' "$gpgout" | grep -c '^\[GNUPG:\] NEWSIG' || true)"
  valid="$(printf '%s\n' "$gpgout" | awk '/^\[GNUPG:\] VALIDSIG /{print $NF}')"
  nvalid="$(printf '%s\n' "$valid" | grep -c . || true)"
  ok=1
  [ "$nsig" -ge 1 ] || { echo "   no signatures found" >&2; ok=0; }
  [ "$nsig" -eq "$nvalid" ] || { echo "   $nsig signature(s) but only $nvalid valid" >&2; ok=0; }
  for f in $valid; do
    if is_maintainer_fpr "$f"; then echo "   good signature: $(spaced_fpr "$f") ($(maintainer_email_for "$f"))"
    else echo "   signature from NON-ALLOWED key $f" >&2; ok=0; fi
  done
  [ "$ok" -eq 1 ]
}

# Refuse to sign an already public release; the point is to sign before publishing.
draft="$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)"
if [ "$draft" != "true" ]; then
  echo "release $TAG is not a draft; refusing to sign after publication" >&2
  exit 1
fi

echo "== download draft assets"
gh release download "$TAG" --repo "$REPO" --dir "$WORK" -p SHA256SUMS -p lnd-sweeper.html
if ! grep -Eq '^[0-9a-f]{64}  lnd-sweeper\.html$' "$WORK/SHA256SUMS"; then
  echo "SHA256SUMS in the draft is empty or malformed (expected a line for lnd-sweeper.html)" >&2
  exit 1
fi
( cd "$WORK" && $SHA -c SHA256SUMS )
if gh release download "$TAG" --repo "$REPO" --dir "$WORK" -p SHA256SUMS.asc 2>/dev/null && [ -f "$WORK/SHA256SUMS.asc" ]; then
  echo "== existing SHA256SUMS.asc found; verifying its signatures"
  verify_all "$WORK/SHA256SUMS.asc" "$WORK/SHA256SUMS" || { echo "FAIL: existing SHA256SUMS.asc has a bad or non-allowed signature. Do not append to it; investigate." >&2; exit 1; }
  EXISTING="$(GNUPGHOME="$VHOME" gpg --batch --status-fd 1 --verify "$WORK/SHA256SUMS.asc" "$WORK/SHA256SUMS" 2>/dev/null | awk '/^\[GNUPG:\] VALIDSIG /{print $NF}')"
else
  EXISTING=""
  echo "== no existing SHA256SUMS.asc"
fi

echo "== attestation"
if gh attestation verify "$WORK/lnd-sweeper.html" --repo "$REPO" >/dev/null 2>&1; then
  echo "   provenance attestation OK"
elif [ "${SKIP_ATTESTATION:-}" = "1" ]; then
  echo "   ##########################################################################" >&2
  echo "   # WARNING: attestation check FAILED or could not run, and SKIP_ATTESTATION=1 #" >&2
  echo "   # is set. You are about to sign a file whose build provenance is NOT     #" >&2
  echo "   # proven. Only continue if you have verified the attestation another way. #" >&2
  echo "   ##########################################################################" >&2
else
  echo "FAIL: gh attestation verify failed for lnd-sweeper.html. Refusing to sign." >&2
  echo "      Update gh (needs 'gh attestation'), check you are online, and confirm the release" >&2
  echo "      workflow attested this file. To override knowingly: SKIP_ATTESTATION=1 $0 $TAG" >&2
  exit 1
fi

echo "== local rebuild from $TAG"
if [ "$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || true)" != "$TAG" ]; then
  echo "checkout is not at tag $TAG (run: git checkout $TAG)" >&2
  exit 1
fi
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "working tree is not clean; refusing to build a release from it" >&2
  exit 1
fi
( cd "$ROOT" && NODE_ENV=production pnpm install --frozen-lockfile --prod=false --silent && NODE_ENV=production pnpm build --logLevel warn )
local_hash="$($SHA "$ROOT/dist/lnd-sweeper.html" | cut -d' ' -f1)"
release_hash="$(cut -d' ' -f1 "$WORK/SHA256SUMS")"
if [ "$local_hash" != "$release_hash" ]; then
  echo "FAIL: local build $local_hash != release $release_hash" >&2
  echo "Do not sign. Investigate before publishing." >&2
  exit 1
fi
echo "   local rebuild matches: $local_hash"

echo "== choose signing key"
if [ -n "${GPG_KEY:-}" ]; then
  SIGNER="$(gpg --batch --with-colons --list-secret-keys "$GPG_KEY" 2>/dev/null | awk -F: '/^sec:/{p=1;next} p&&/^fpr:/{print $10; exit}')"
  [ -n "$SIGNER" ] || { echo "FAIL: no secret key for GPG_KEY=$GPG_KEY" >&2; exit 1; }
  is_maintainer_fpr "$SIGNER" || { echo "FAIL: $SIGNER is not an allowed maintainer key" >&2; exit 1; }
else
  SIGNER=""; n=0
  for fpr in $(maintainer_fprs); do
    if gpg --batch --list-secret-keys "$fpr" >/dev/null 2>&1; then SIGNER="$fpr"; n=$((n + 1)); fi
  done
  [ "$n" -ge 1 ] || { echo "FAIL: none of the allowed maintainer secret keys is in your keyring" >&2; exit 1; }
  [ "$n" -eq 1 ] || { echo "FAIL: $n allowed maintainer secret keys present; set GPG_KEY to choose" >&2; exit 1; }
fi
echo "   signing as $(spaced_fpr "$SIGNER") ($(maintainer_email_for "$SIGNER"))"
if printf '%s\n' "$EXISTING" | grep -q -x -F "$SIGNER"; then
  echo "FAIL: SHA256SUMS.asc already carries a signature from this key" >&2
  exit 1
fi

echo "== sign"
cd "$WORK"
gpg --armor --detach-sign --local-user "$SIGNER" --output new.asc SHA256SUMS
if [ -n "$EXISTING" ]; then
  cat SHA256SUMS.asc new.asc > combined.asc
else
  cp new.asc combined.asc
fi

echo "== verify combined SHA256SUMS.asc against keys/ only"
verify_all combined.asc SHA256SUMS || { echo "FAIL: combined SHA256SUMS.asc did not verify" >&2; exit 1; }
total="$(GNUPGHOME="$VHOME" gpg --batch --status-fd 1 --verify combined.asc SHA256SUMS 2>/dev/null | grep -c '^\[GNUPG:\] VALIDSIG ' || true)"
mv combined.asc SHA256SUMS.asc
echo "   $total valid signature(s)"

echo "== upload SHA256SUMS.asc to draft"
gh release upload "$TAG" --repo "$REPO" --clobber SHA256SUMS.asc

echo
if [ "$total" -lt 2 ]; then
  echo "One signature so far. If the other maintainer is available, they should run this script too before publishing."
fi
echo "Review the draft, then publish with:"
echo
echo "  gh release edit $TAG --repo $REPO --draft=false"
