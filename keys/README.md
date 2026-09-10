# Maintainer signing keys

Public PGP keys allowed to sign releases. The authoritative list is `scripts/maintainer-keys.sh`; CI runs `scripts/verify-maintainer-key.sh` to check these files, that list and the documents agree, and that this directory holds nothing else.

What they sign: `SHA256SUMS.asc` on every public release, detached signatures over the `SHA256SUMS` file that lists the SHA-256 of `lnd-sweeper.html`. They sign nothing else in this project. At least one valid signature is required per release, two when both maintainers are available. See the README section "Maintainer signature" for how to verify.

## rich-henderson.asc

Rich Henderson, `Rich (Musqet) <rich@musqet.tech>`
Fingerprint: `D288 E784 08C2 0FA6 4DA6 C0E6 403E 5FAF 3E49 4185`
RSA 4096, created 2025-07-28, expires 2029-07-28, one encryption subkey.
Origin: <https://keys.openpgp.org/vks/v1/by-email/rich@musqet.tech> (keys.openpgp.org). Cross-check the fingerprint there, not only here.

## ben-de-waal.asc

Ben de Waal, `Ben de Waal <ben@musqet.tech>`
Fingerprint: `0846 EDC0 041B 695E 8CB7 94A0 99F1 B934 03D1 4A70`
RSA 4096, created 2025-11-24, expires 2040-12-31, one encryption subkey.
Origin: <https://keys.openpgp.org/vks/v1/by-email/ben@musqet.tech> (keys.openpgp.org). Cross-check the fingerprint there, not only here.
