# Contributing

Thanks for looking. This is a small tool that handles seed words, so the bar for changes is deliberately high.

## Dependency policy

No new runtime dependencies without maintainer approval, and expect the answer to be no. The runtime dependency list is fixed to `@noble/curves`, `@noble/hashes`, `@scure/bip32` and `@scure/btc-signer`. Every extra package is more code a user has to trust with their seed.

Dev-only tools are also fixed unless you can show the work cannot be done without one. Say so in the pull request.

Dependency version bumps are fine but must be their own pull request, and `pnpm build` must still pass `scripts/verify-reproducible.sh`.

## Before you open a pull request

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
scripts/verify-reproducible.sh
```

All four must pass. CI runs the same steps.

## What we want

- Bug fixes with a failing test first.
- Test vectors, especially ones cross-checked against `lnd` or `chantools`.
- Clearer wording in the UI or docs. British English, plain, no marketing.

## What we do not want

- Features that need the page to talk to anything other than the chain source the user picks.
- Frameworks, build tool swaps, or "modernisation" for its own sake.
- Anything that makes the output HTML non-reproducible.

## Releasing (maintainers)

Every public release must carry `SHA256SUMS.asc` with at least one valid signature from an allowed maintainer key, and two when both maintainers are available. The allowed keys are listed in `scripts/maintainer-keys.sh` and published in `keys/`: Rich Henderson `D288 E784 08C2 0FA6 4DA6 C0E6 403E 5FAF 3E49 4185` and Ben de Waal `0846 EDC0 041B 695E 8CB7 94A0 99F1 B934 03D1 4A70`, both also on keys.openpgp.org. The workflow only produces a draft.

1. Bump `version` in `package.json` (the UI reads it at build time through `__APP_VERSION__`, defined in `vite.config.ts`) and commit.
2. Tag and push: `git tag -s vX.Y.Z && git push origin vX.Y.Z`. The release workflow refuses a tag that does not match `package.json`.
3. The workflow typechecks, tests, checks reproducibility, builds, writes `SHA256SUMS`, attests provenance and creates a **draft** release with `lnd-sweeper.html` and `SHA256SUMS`.
4. Each maintainer, on their own machine, at a clean checkout of the tag, with their secret key available to gpg, runs:

   ```sh
   scripts/release-sign.sh vX.Y.Z
   ```

   It downloads the draft's `SHA256SUMS` and `lnd-sweeper.html`, checks the build provenance attestation with `gh attestation verify` and refuses to sign if that fails (`SKIP_ATTESTATION=1` overrides with a loud warning; use it only if you have verified provenance another way), rebuilds locally and refuses to continue unless the hash matches, picks your key (the one allowed secret key in your keyring, or `GPG_KEY`), and signs `SHA256SUMS`. If the draft already has a `SHA256SUMS.asc` from the other maintainer it verifies those signatures against `keys/` first, appends yours, and re-verifies the combined file in a throwaway keyring built only from `keys/` (every signature valid, every signer allowed, no duplicate signer) before uploading it with `--clobber`. It never generates a key.
5. When the second maintainer is available, they run the same command; the file then holds both signatures.
6. Review the draft on GitHub, then publish: `gh release edit vX.Y.Z --draft=false`.

Never generate a signing key on a CI runner and never add a private key as a repository secret. To add, rotate or remove a maintainer key, update `scripts/maintainer-keys.sh`, the file in `keys/`, `keys/README.md`, and the fingerprint tables in README.md, SECURITY.md and this file together; CI runs `scripts/verify-maintainer-key.sh`, which fails if any of them disagree or if `keys/` holds an unlisted file.

## Security issues

Do not open an issue. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree your work is released under the MIT licence in [LICENSE](LICENSE).
