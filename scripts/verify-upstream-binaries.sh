#!/usr/bin/env sh
# Download the pinned Bitcoin Core and lnd Linux release tarballs, check the
# maintainers' GPG signatures on the published hash lists, then check the
# tarballs against both the signed lists and the hashes pinned in this file.
#
# Usage: scripts/verify-upstream-binaries.sh <outdir> [arch]
#   arch: x86_64 (default) or aarch64
# On success <outdir> contains bitcoind, bitcoin-cli, lnd and lncli.
#
# Trust anchors, all pinned here and updated together:
#   - the release versions and tarball SHA-256s,
#   - the commit of bitcoin-core/guix.sigs whose builder-keys/ we import,
#   - the lnd release commit whose scripts/keys/ we import.
# gpg is required (present on GitHub ubuntu runners and most desktops).
set -eu

OUT="${1:?usage: $0 <outdir> [x86_64|aarch64]}"
ARCH="${2:-x86_64}"

# ---- pins ------------------------------------------------------------------
BITCOIN_VERSION="31.1"
# https://bitcoincore.org/bin/bitcoin-core-31.1/SHA256SUMS
BITCOIN_SHA256_x86_64="b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"
BITCOIN_SHA256_aarch64="dcf1873f2208ba4f962f3398d47e154c39c0084be8f4553e05c940d0ace3d004"
# Builder keys: https://github.com/bitcoin-core/guix.sigs/tree/<commit>/builder-keys
GUIX_SIGS_COMMIT="3b667ee3ebb3dcd9e1990cf03e38a0935eec1683"
BITCOIN_MIN_SIGS=3

LND_VERSION="v0.21.3-beta"
# https://github.com/lightningnetwork/lnd/releases/download/v0.21.3-beta/manifest-v0.21.3-beta.txt
LND_SHA256_amd64="aad62005d25bb0d974c5c1b135decc269d8f3e69ee9cde8bb6b32998100bc3fd"
LND_SHA256_arm64="2c67fa798c008d82255501fe76b2f1ef1e1c6fc71d4418d078ed83466cb35db8"
# Commit the v0.21.3-beta tag points at; keys come from scripts/keys/ there.
LND_COMMIT="572b561bf05f03dfe6135110970c4d858c3482dc"
# Signers of this release (one manifest-<name>-<ver>.sig each on the release page).
LND_SIGNERS="boris georgetsagk gijswijs hieblmi suheb ViktorT-11 ziggie1984"
LND_MIN_SIGS=2
# ----------------------------------------------------------------------------

case "$ARCH" in
  x86_64)  LND_ARCH=amd64; BITCOIN_SHA256="$BITCOIN_SHA256_x86_64"; LND_SHA256="$LND_SHA256_amd64" ;;
  aarch64) LND_ARCH=arm64; BITCOIN_SHA256="$BITCOIN_SHA256_aarch64"; LND_SHA256="$LND_SHA256_arm64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 2 ;;
esac

command -v gpg >/dev/null 2>&1 || { echo "gpg is required" >&2; exit 2; }
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lnd-sweeper-upstream.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM
export GNUPGHOME="$WORK/gnupg"
mkdir -p "$GNUPGHOME" "$OUT"
chmod 700 "$GNUPGHOME"

fetch() { curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"; }

good_sigs() {
  # Count distinct "Good signature" lines in gpg --status-fd output ("GOODSIG").
  grep -c '^\[GNUPG:\] GOODSIG ' "$1" || true
}

check_pinned() {
  echo "$2  $1" | $SHA -c - >/dev/null || { echo "FAIL: $1 does not match pinned SHA-256" >&2; exit 1; }
}

# ---- Bitcoin Core ----------------------------------------------------------
echo "== Bitcoin Core ${BITCOIN_VERSION} (${ARCH})"
B="$WORK/bitcoin"; mkdir -p "$B"
BASE="https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}"
TARBALL="bitcoin-${BITCOIN_VERSION}-${ARCH}-linux-gnu.tar.gz"
fetch "$BASE/SHA256SUMS" "$B/SHA256SUMS"
fetch "$BASE/SHA256SUMS.asc" "$B/SHA256SUMS.asc"
fetch "$BASE/$TARBALL" "$B/$TARBALL"

fetch "https://github.com/bitcoin-core/guix.sigs/archive/${GUIX_SIGS_COMMIT}.tar.gz" "$B/guix.sigs.tar.gz"
mkdir -p "$B/keys"
tar -xzf "$B/guix.sigs.tar.gz" -C "$B/keys" --strip-components=2 "guix.sigs-${GUIX_SIGS_COMMIT}/builder-keys"
for k in "$B"/keys/*.gpg; do gpg --batch --quiet --import "$k" 2>/dev/null || true; done

gpg --batch --status-fd 1 --verify "$B/SHA256SUMS.asc" "$B/SHA256SUMS" > "$B/gpg.status" 2>"$B/gpg.err" || true
N="$(good_sigs "$B/gpg.status")"
echo "   good builder signatures on SHA256SUMS: $N (need >= $BITCOIN_MIN_SIGS)"
[ "$N" -ge "$BITCOIN_MIN_SIGS" ] || { cat "$B/gpg.err" >&2; echo "FAIL: too few good signatures on Bitcoin Core SHA256SUMS" >&2; exit 1; }
(cd "$B" && grep " $TARBALL\$" SHA256SUMS | $SHA -c - >/dev/null) || { echo "FAIL: $TARBALL does not match signed SHA256SUMS" >&2; exit 1; }
check_pinned "$B/$TARBALL" "$BITCOIN_SHA256"
tar -xzf "$B/$TARBALL" -C "$B"
cp "$B/bitcoin-${BITCOIN_VERSION}/bin/bitcoind" "$B/bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli" "$OUT/"
echo "   OK"

# ---- lnd -------------------------------------------------------------------
echo "== lnd ${LND_VERSION} (linux-${LND_ARCH})"
L="$WORK/lnd"; mkdir -p "$L"
BASE="https://github.com/lightningnetwork/lnd/releases/download/${LND_VERSION}"
TARBALL="lnd-linux-${LND_ARCH}-${LND_VERSION}.tar.gz"
MANIFEST="manifest-${LND_VERSION}.txt"
fetch "$BASE/$MANIFEST" "$L/$MANIFEST"
fetch "$BASE/$TARBALL" "$L/$TARBALL"

N=0
for s in $LND_SIGNERS; do
  fetch "https://raw.githubusercontent.com/lightningnetwork/lnd/${LND_COMMIT}/scripts/keys/${s}.asc" "$L/$s.asc" || { echo "   no key for $s at pinned commit" >&2; continue; }
  gpg --batch --quiet --import "$L/$s.asc" 2>/dev/null || true
  fetch "$BASE/manifest-${s}-${LND_VERSION}.sig" "$L/$s.sig" || { echo "   no signature from $s" >&2; continue; }
  if gpg --batch --status-fd 1 --verify "$L/$s.sig" "$L/$MANIFEST" 2>/dev/null | grep -q '^\[GNUPG:\] GOODSIG '; then
    N=$((N + 1)); echo "   good signature: $s"
  else
    echo "   BAD or unverifiable signature: $s" >&2
  fi
done
echo "   good maintainer signatures on manifest: $N (need >= $LND_MIN_SIGS)"
[ "$N" -ge "$LND_MIN_SIGS" ] || { echo "FAIL: too few good signatures on lnd manifest" >&2; exit 1; }
(cd "$L" && grep " $TARBALL\$" "$MANIFEST" | $SHA -c - >/dev/null) || { echo "FAIL: $TARBALL does not match signed manifest" >&2; exit 1; }
check_pinned "$L/$TARBALL" "$LND_SHA256"
tar -xzf "$L/$TARBALL" -C "$L"
cp "$L/lnd-linux-${LND_ARCH}-${LND_VERSION}/lnd" "$L/lnd-linux-${LND_ARCH}-${LND_VERSION}/lncli" "$OUT/"
echo "   OK"

chmod 0755 "$OUT"/bitcoind "$OUT"/bitcoin-cli "$OUT"/lnd "$OUT"/lncli
echo "Verified binaries in $OUT"
