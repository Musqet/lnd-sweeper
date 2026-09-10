# Security

lnd-sweeper handles seed words and private keys. Please take the time to report anything that looks wrong.

## Reporting a vulnerability

Email security@musqet.tech. Include:

- what the problem is and where in the code it lives,
- how to reproduce it (a failing test or a concrete input is ideal),
- what an attacker could do with it.

Do not open a public GitHub issue for anything that could put a user's funds at risk. If you want to send something encrypted, say so in a first plain email and we will arrange a key.

You should hear back within three working days. We will tell you when we have confirmed the problem, when a fix is out, and we will credit you in the release notes if you want that.

## Verifying a release

Before you put a seed into it, check the file three ways. Details are in the README.

1. SHA-256 against the value on the release page and in `SHA256SUMS`.
2. Build provenance: `gh attestation verify lnd-sweeper.html --repo Musqet/lnd-sweeper` proves GitHub Actions built that exact file from this repository at that tag.
3. Maintainer signatures: `SHA256SUMS.asc`, detached GPG signatures over `SHA256SUMS` made offline with keys that are never on GitHub. At least one valid signature from an allowed maintainer key is required, two when both maintainers are available. Allowed keys, also on keys.openpgp.org: Rich Henderson `D288 E784 08C2 0FA6 4DA6 C0E6 403E 5FAF 3E49 4185` (`keys/rich-henderson.asc`) and Ben de Waal `0846 EDC0 041B 695E 8CB7 94A0 99F1 B934 03D1 4A70` (`keys/ben-de-waal.asc`). `gpg --verify SHA256SUMS.asc SHA256SUMS` must report a good signature from at least one of those fingerprints and from no other key.

A public release missing any of these, or with a hash that does not match a local rebuild, is itself a security issue. Report it.

## What counts

Anything that could cause a user to lose funds or leak their seed, for example:

- incorrect key derivation or signing that produces an unspendable or wrong transaction,
- any way for the page to send seed material or private keys anywhere,
- any network request other than to the chain source the user configured,
- a build that differs from the source, or a weakness in the reproducible build or release process,
- weaknesses in the way the file is verified or distributed.

## What does not count

- A user pasting their seed into a modified or unverified copy of the file. The README tells users to verify the SHA-256 against the release before use.
- Malware on the user's machine.
- The chain source (Esplora server) learning which addresses the user looked up. That is inherent to the design and is documented.
- Denial of service against a public Esplora server.

## Supported versions

Only the latest release is supported. Old releases are left up for reference but will not be patched.
