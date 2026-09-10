# chantools ground-truth fixtures

Generated with lightninglabs/chantools v0.14.2 (`genimportscript`, `showrootkey`) for the
seven seeds in `../aezeed-vectors.json`.

- `<seed>.rootkey.txt`: BIP32 root xprv (chantools prints mainnet version bytes for every network).
- `<seed>.mainnet.<purpose>.descriptors.txt`: `--derivationpath m/<purpose>'/0'/0'`, window 25,
  so external indices 0..24 then internal 0..24. Each line carries the WIF and the labelled
  sh(wpkh), wpkh and tr addresses for one key.
- `<seed>.<regtest|testnet>.<purpose>.coin<0|1>.descriptors.txt`: same off mainnet, for both coin
  types. lnd's wallet (btcwallet key scopes) uses coin type 0 on every network; coin type 1 files
  exist so the scanner's belt-and-braces pass can be tested too.
- `<seed>.<network>.lndpaths.electrum.txt`: chantools `--lndpaths` (coin 0 on all networks, plus the
  m/1017' payment-base family which is not a wallet path), window 5, Electrum format.

Signet is absent because chantools 0.14.2 panics on `--signet` in genimportscript
(SeedBirthdayToBlock unimplemented). Signet shares address and WIF encoding with testnet.
