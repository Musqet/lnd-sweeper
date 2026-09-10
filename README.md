# lnd-sweeper

Recover the on-chain funds of a dead LND node using only its 24 seed words.

One HTML file. Download it, check its hash, open it from disk. It derives the addresses your lnd wallet would have used, asks a block explorer of your choice which ones hold coins, and builds a single transaction that sweeps everything to an address you give it. Nothing to install, nothing to sync.

## When to use it

- Your lnd node is gone (disk died, server deleted, laptop lost) and you still have the 24 words.
- You only need the on-chain wallet balance: coins that were sitting in lnd's wallet, not locked in channels.
- You want to move those coins to another wallet and never touch lnd again.

## When not to use it

- **You had open channels.** Channel funds are not in the wallet's normal addresses and this tool will not see them. Restore the seed into a new lnd node with your static channel backup (`channel.backup`), or use [chantools](https://github.com/lightninglabs/chantools). Sweeping the wallet first is fine, but do not assume the wallet balance is all your money.
- **Your node still works.** Just use `lncli sendcoins`.
- **You do not have the 24 words.** There is nothing this tool can do for you.
- **The seed is not aezeed.** lnd's 24 words are aezeed, not BIP39. If your wallet was created by something else (Electrum, a hardware wallet, a BIP39 phrase), use that wallet's own restore.

## How it works

1. **Decode the seed.** lnd's 24 words are an aezeed cipherseed. The tool checks the word list and checksum, decrypts the seed with the cipher seed passphrase (see below) using scrypt and AEZ, and gets the 16 bytes of entropy lnd used as its BIP32 master seed.
2. **Derive addresses.** lnd has used three address types over the years, at three BIP32 paths: `m/49'/coin'/0'/…` (nested SegWit, `3…`), `m/84'/coin'/0'/…` (native SegWit, `bc1q…`) and `m/86'/coin'/0'/…` (Taproot, `bc1p…`). lnd uses coin type 0 for its wallet on every network, including testnet, signet and regtest (it never switched to the BIP44 test coin type). The tool derives coin type 0 everywhere, and off mainnet it also scans coin type 1 as a precaution. For each path it derives both the receive branch (change 0) and the change branch (change 1). One wrinkle: on `m/49'` lnd's receive addresses are nested P2WPKH (`3…`), but its change addresses on the same path are native P2WPKH (`bc1q…`), a btcwallet quirk called BIP0049Plus. So the tool scans six real branches, and on the full pass adds a belt-and-braces seventh: the `m/49'` change branch encoded as nested addresses, which lnd never produces but other tooling could have paid to.
3. **Scan.** The tool checks addresses in order on each path and stops after a run of unused ones, the same gap-limit idea every wallet uses. It works in two tiers (`SCAN_TIERS` in `src/chain/scanner.ts`):

   - **Default: a gap of 100.** Each branch is scanned until 100 unused addresses in a row have been seen. lnd hands out addresses sequentially, so a node whose channels have all been closed rarely leaves a gap anywhere near that; BIP44 wallets stop at 20. On an empty wallet this is 6 branches of 100, about 600 lookups on mainnet, around 75 seconds on a public server at the default pace of 8 requests a second. Off mainnet, where coin type 1 is scanned too, it is 1,200 lookups and about twice as long.
   - **On request: lnd's full window of 2,500.** This is what `lncli create --recovery-window` defaults to, for wallets that skipped far ahead in the index. It continues from where the first tier stopped rather than starting again, and adds the seventh belt-and-braces branch. On an empty wallet it adds about 16,900 lookups on mainnet (17,500 in total) and takes about 35 minutes on a public server; off mainnet, double both.

   Every address that turns out to have history costs one more lookup and pushes its branch's horizon out by another window. It asks an Esplora-compatible block explorer for the unspent outputs at each address. Public servers rate-limit, so by default the scan spreads across a small set of trusted public servers (on mainnet: mempool.space, blockstream.info, and the mempool.emzy.de and mempool.bitaroo.net community instances; fewer on the test networks). This is failover, not round-robin: it prefers one server and moves to the next the instant that one answers 429, cooling the busy one and returning to it when it recovers, so a single server's rate limit never stalls recovery. Choose "your own server" instead and only the one URL you give is used, with the classic single-server pacing: honour `Retry-After`, slow the request rate, speed back up once the server is happy. Either way partial results are never lost: a scan that is stopped or gives up can be continued from where it got to. The trusted set lives in `src/chain/servers.ts` and the failover logic in `src/chain/rotating.ts`; the lookup figures above come from `SCAN_COST` in `src/chain/scanner.ts`, which is the truth if the defaults change.
4. **Sweep.** Every unspent output found goes into one transaction paying a single address you provide, with the fee rate you pick. You review the inputs, outputs and fee before anything is signed. Signing happens in the page. You can broadcast through the same explorer or copy the raw hex and broadcast it yourself.

## Safety

Read this before you type your seed anywhere.

1. **Download only from the GitHub releases page** of this repository. Do not run a copy someone sent you or one hosted on another site.
2. **Check the SHA-256.** The release page prints the hash. Compare it to the file you downloaded. You need a terminal: on macOS open Terminal (Spotlight, type "Terminal"), on Windows open PowerShell (Start, type "PowerShell"), on Linux open your terminal app. Then move to your Downloads folder and run the command for your system:

   ```sh
   cd ~/Downloads                        # macOS and Linux
   cd $HOME\Downloads                    # Windows PowerShell

   sha256sum lnd-sweeper.html            # Linux
   shasum -a 256 lnd-sweeper.html        # macOS
   certutil -hashfile lnd-sweeper.html SHA256   # Windows
   ```

   If it does not match, delete the file. Do not use it.

   If you have the GitHub CLI, you can also check that this exact file was built by GitHub Actions from this repository's source at that tag, not on someone's laptop:

   ```sh
   gh attestation verify lnd-sweeper.html --repo Musqet/lnd-sweeper
   ```

   See "Build provenance" below for what that proves.
3. **Open it from disk**, as a `file://` URL, in an up-to-date browser. Do not paste it into an online sandbox or serve it from a web server.
4. **Go offline while you enter the seed.** Turn off wifi, decode the seed, derive addresses, then reconnect only for the scan and broadcast steps. The tool is written so that seed entry and derivation need no network.
5. **Know what leaves your machine.** The only network traffic is to the chain source you choose. With the trusted public servers, in the usual case one server sees your addresses and the tool only falls back to another when the first rate-limits, so a slice may reach a second server too; each server that answers learns the addresses it was asked about, which links them together and to your IP address. Choose "your own server" to keep everything on one host you control, and use your own Esplora instance or Tor if that matters to you. Nothing else is contacted. There is no telemetry, no update check, no fonts or scripts from the web. Be clear about what enforces this: the page's Content Security Policy blocks scripts, styles, fonts and frames from the web, but it has to allow `connect-src` to any `https:` or `http:` host because you might point it at your own explorer on any address. So "only your chosen source" is a promise kept by the code you can read and hash, not one the browser enforces for you. If that is not good enough, run it on a machine with no network and broadcast the signed transaction elsewhere.
6. **Close the tab when you are done.** Keys live in page memory only. Reload or close to clear them.
7. **Move the funds to a fresh wallet.** Once a seed has been typed into a computer, treat it as spent.

### Passphrase

lnd has two different passwords and people mix them up:

- The **wallet unlock password** is what you typed into `lncli unlock`. It protected the wallet file on the dead node. It is not part of the seed and this tool never asks for it.
- The **cipher seed passphrase** is an optional extra passphrase offered when the seed was created (`lncli create` asks "Input your passphrase if you wish to encrypt it (or press enter to proceed without a cipher seed passphrase)"). Most people pressed enter. If you did, leave the passphrase field empty and the tool uses lnd's default (`aezeed`). If you did set one and you get it wrong, the checksum will fail and you will get an error, not a wrong wallet.

### Threat model

What this tool defends against:

- A tampered download: the build is reproducible (below), every release publishes its hash and a signed build provenance attestation, and a maintainer may add an out-of-band signature, so anyone can check the file matches the source.
- A malicious or compromised chain source: it can lie about your balance or refuse to broadcast, but it never sees your seed or keys and cannot change where the sweep pays to. Verify the destination address on screen before signing, and check the transaction on a second explorer after broadcast.
- Supply chain: four small, well-known runtime dependencies (`@noble/curves`, `@noble/hashes`, `@scure/bip32`, `@scure/btc-signer`), pinned by lockfile, all inlined into the file you hash. No new dependencies are accepted without review.

What it does not defend against:

- Malware, a keylogger, or a malicious browser extension on the machine you run it on. Use a clean machine if you can, and treat the seed as compromised afterwards.
- Someone watching your screen or your clipboard.
- Address linkage at the chain source (see point 5 above).
- Channel funds. See "When not to use it".

## Reproducible build

Every release is built by GitHub Actions from a tagged commit, and the build is byte-for-byte deterministic. You can rebuild it yourself and compare hashes with the release.

Requirements: Node 24.21.0 (`.nvmrc`), pnpm 10.28.0 (`packageManager` in `package.json`; `corepack enable` will pick it up).

```sh
git clone https://github.com/Musqet/lnd-sweeper.git
cd lnd-sweeper
git checkout v1.0.0            # the tag you want to check
pnpm install --frozen-lockfile
pnpm build
sha256sum dist/lnd-sweeper.html
```

The hash should match the one on the release page for that tag, and the `SHA256SUMS` file attached to it. If it does not, please open an issue with your OS, Node and pnpm versions.

To check determinism on your own machine, `scripts/verify-reproducible.sh` copies the tree twice, installs and builds in each copy and diffs the results. CI runs it on every push.

What makes it deterministic: the lockfile pins every package, the `.npmrc` refuses installs that would change it, there are no sourcemaps, no timestamps, no absolute paths and no hashed filenames in the output, and the output is one file with a fixed name. The build refuses to run in anything but production mode, because a development build would inline the local test mock and change the hash.

### Build provenance

Every release run also publishes a signed build provenance attestation (SLSA, via Sigstore) for `lnd-sweeper.html` and `SHA256SUMS`. It states which repository, tag, commit and workflow produced the exact bytes you downloaded. Check it with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify lnd-sweeper.html --repo Musqet/lnd-sweeper
gh attestation verify SHA256SUMS --repo Musqet/lnd-sweeper
```

What it proves: the file was built by GitHub's runners from this repository's source at the stated tag, and has not been altered since. What it does not prove: that the source is correct, or that GitHub itself is honest. The reproducible build covers the first gap (rebuild and compare); the maintainer signature below covers the second.

### Maintainer signature

The attestation and the release page both depend on GitHub. For a trust anchor held outside GitHub, every public release also carries `SHA256SUMS.asc`: detached GPG signatures over `SHA256SUMS`, made by the maintainers on their own machines with keys the workflow never has. The workflow only creates a draft; a maintainer verifies the draft against a local rebuild, signs, uploads, and only then is it published.

Policy: `SHA256SUMS.asc` must hold at least one valid signature from an allowed maintainer key, and two when both maintainers are available. A public release with no `SHA256SUMS.asc`, or with a signature from any other key, is a mistake: report it.

Allowed maintainer keys (the list is `scripts/maintainer-keys.sh`; the public keys are in [`keys/`](keys/)):

| Maintainer | Fingerprint | Key file | Keyserver |
|---|---|---|---|
| Rich Henderson, `Rich (Musqet) <rich@musqet.tech>` | `D288 E784 08C2 0FA6 4DA6 C0E6 403E 5FAF 3E49 4185` | `keys/rich-henderson.asc` | <https://keys.openpgp.org/vks/v1/by-email/rich@musqet.tech> |
| Ben de Waal, `Ben de Waal <ben@musqet.tech>` | `0846 EDC0 041B 695E 8CB7 94A0 99F1 B934 03D1 4A70` | `keys/ben-de-waal.asc` | <https://keys.openpgp.org/vks/v1/by-email/ben@musqet.tech> |

Do not take this repository's word for the fingerprints: fetch each key from the keyserver as well and check both copies report the fingerprint above. A key that only exists in the repository would prove nothing if the repository were compromised.

Check a release:

```sh
gpg --import keys/rich-henderson.asc keys/ben-de-waal.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
```

`SHA256SUMS.asc` can contain more than one signature (the same convention Bitcoin Core uses), so `gpg --verify` prints one block per signer. Every block must say `Good signature` and print a primary key fingerprint from the table above; at least one is required, two is the norm. gpg prints fingerprints with a double space after the fifth group, for example `D288 E784 08C2 0FA6 4DA6  C0E6 403E 5FAF 3E49 4185`; compare ignoring spaces, so the hex digits must match, the spacing need not. Ignore any "not certified with a trusted signature" warning: that only means you have not marked the keys trusted in your own keyring. A bad signature, an unlisted fingerprint, or a missing `SHA256SUMS.asc` means do not use the file.

Maintainers: the signing steps are in [CONTRIBUTING.md](CONTRIBUTING.md) and automated in `scripts/release-sign.sh`.

## Running tests

```sh
pnpm install --frozen-lockfile
pnpm typecheck        # TypeScript
pnpm test             # unit tests, including aezeed and derivation vectors cross-checked against lnd and chantools
pnpm test:e2e         # regtest end to end: needs bitcoind and lnd on PATH (pinned versions and checksums in scripts/verify-upstream-binaries.sh, which can also download and verify them for you on Linux)
```

The e2e suite creates a real lnd wallet on regtest, funds it, kills the node and sweeps with this tool. It runs nightly in CI.

## Development

```sh
pnpm dev              # local dev server
pnpm build            # dist/lnd-sweeper.html
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dependency policy and [SECURITY.md](SECURITY.md) for reporting problems.

## Licence

MIT. See [LICENSE](LICENSE).
