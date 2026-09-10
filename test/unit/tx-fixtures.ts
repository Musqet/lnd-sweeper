/**
 * Test helpers: turn chantools descriptor dumps into DerivedKey / OwnedUtxo values.
 * Each fixture line carries one WIF and its three labelled addresses:
 * sh(wpkh(WIF)) -> np2wkh, wpkh(WIF) -> p2wkh, tr(WIF) -> p2tr.
 * Per test/fixtures/chantools/README.md each dump is m/<purpose>'/<coin>'/0' with window 25:
 * lines 0..24 are external (change 0) indices 0..24, lines 25..49 internal (change 1).
 */
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PURPOSE_FOR_KIND, coinTypeFor, type AddressKind, type DerivedAddress, type DerivedKey, type Network, type OwnedUtxo } from "../../src/types";

// Vite raw imports keep this helper free of node: imports (the project has no @types/node).
const FIXTURES = import.meta.glob("../fixtures/chantools/*.descriptors.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const REGTEST_NET = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
export const SIGNET_NET = btc.TEST_NETWORK;
export function btcNetwork(network: Network) {
  return network === "mainnet" ? btc.NETWORK : network === "regtest" ? REGTEST_NET : btc.TEST_NETWORK;
}

export interface FixtureKey {
  wif: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  addresses: Record<AddressKind, string>;
  network: Network;
  purpose: 49 | 84 | 86;
  coin: 0 | 1;
  change: 0 | 1;
  index: number;
  path: string;
}

const WINDOW = 25;

const LINE_RE = /sh\(wpkh\((\w+)\)\)#\w+","timestamp":"now","label":"([^"]+)"\},\{"desc":"wpkh\(\w+\)#\w+","timestamp":"now","label":"([^"]+)"\},\{"desc":"tr\(\w+\)#\w+","timestamp":"now","label":"([^"]+)"/;

/**
 * Keys from one chantools descriptor dump, e.g. ("random1-default", "regtest", 84).
 * lnd uses coin type 0 on every network; mainnet dumps have no coin suffix.
 */
export function fixtureKeys(seed: string, network: Network, purpose: 49 | 84 | 86, coin: 0 | 1 = 0): FixtureKey[] {
  if (network === "signet") throw new Error("no signet fixtures; signet shares testnet encoding");
  const file = network === "mainnet" ? `${seed}.mainnet.${purpose}.descriptors.txt` : `${seed}.${network}.${purpose}.coin${coin}.descriptors.txt`;
  const text = FIXTURES[`../fixtures/chantools/${file}`];
  if (text === undefined) throw new Error(`fixture ${file} not found`);
  const out: FixtureKey[] = [];
  for (const line of text.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const wif = m[1]!;
    const privateKey = btc.WIF(btcNetwork(network)).decode(wif);
    const publicKey = secp256k1.getPublicKey(privateKey, true);
    const n = out.length;
    const change = (n < WINDOW ? 0 : 1) as 0 | 1;
    const index = n % WINDOW;
    out.push({
      wif,
      privateKey,
      publicKey,
      addresses: { np2wkh: m[2]!, p2wkh: m[3]!, p2tr: m[4]! },
      network,
      purpose,
      coin: network === "mainnet" ? 0 : coin,
      change,
      index,
      path: `m/${purpose}'/${network === "mainnet" ? 0 : coin}'/0'/${change}/${index}`,
    });
  }
  if (out.length !== 2 * WINDOW) throw new Error(`expected ${2 * WINDOW} keys in ${file}, parsed ${out.length}`);
  return out;
}

/** The DerivedAddress a fixture key stands for, using the real path from the dump. */
export function fixtureAddress(key: FixtureKey, kind: AddressKind): DerivedAddress {
  return {
    kind,
    purpose: key.purpose,
    network: key.network,
    path: key.path,
    change: key.change,
    index: key.index,
    address: key.addresses[kind],
    publicKey: key.publicKey,
    scriptPubKey: scriptFor(kind, key.publicKey, key.network),
  };
}

/** Output script for a public key and lnd address kind. */
export function scriptFor(kind: AddressKind, publicKey: Uint8Array, network: Network): Uint8Array {
  const net = btcNetwork(network);
  if (kind === "p2wkh") return btc.p2wpkh(publicKey, net).script;
  if (kind === "np2wkh") return btc.p2sh(btc.p2wpkh(publicKey, net), net).script;
  return btc.p2tr(publicKey.subarray(1), undefined, net).script;
}

export function addressFor(kind: AddressKind, publicKey: Uint8Array, network: Network): string {
  const net = btcNetwork(network);
  if (kind === "p2wkh") return btc.p2wpkh(publicKey, net).address!;
  if (kind === "np2wkh") return btc.p2sh(btc.p2wpkh(publicKey, net), net).address!;
  return btc.p2tr(publicKey.subarray(1), undefined, net).address!;
}

export function derivedAddress(
  key: { publicKey: Uint8Array },
  kind: AddressKind,
  network: Network,
  change: 0 | 1 = 0,
  index = 0,
): DerivedAddress {
  return {
    kind,
    purpose: PURPOSE_FOR_KIND[kind],
    network,
    path: `m/${PURPOSE_FOR_KIND[kind]}'/${coinTypeFor(network)}'/0'/${change}/${index}`,
    change,
    index,
    address: addressFor(kind, key.publicKey, network),
    publicKey: key.publicKey,
    scriptPubKey: scriptFor(kind, key.publicKey, network),
  };
}

/** A DerivedKey with a fresh copy of the private key (signSweep zeroes it). */
export function derivedKey(key: FixtureKey | { privateKey: Uint8Array; publicKey: Uint8Array }, owner: DerivedAddress): DerivedKey {
  return { ...owner, privateKey: Uint8Array.from(key.privateKey) };
}

let fakeTxidCounter = 1;
export function fakeTxid(): string {
  const n = fakeTxidCounter++;
  return bytesToHex(new Uint8Array(32).map((_, i) => (i === 31 ? n & 0xff : i === 30 ? (n >>> 8) & 0xff : (i * 7 + n) & 0xff)));
}

export function ownedUtxo(owner: DerivedAddress, value: number, txid = fakeTxid(), vout = 0): OwnedUtxo {
  return { txid, vout, value, status: { confirmed: true, blockHeight: 100 }, owner };
}

/** Builds a keyFor() that hands out fresh key copies and records what was requested. */
export function keyRing(entries: { key: FixtureKey | { privateKey: Uint8Array; publicKey: Uint8Array }; owner: DerivedAddress }[]) {
  const handed: DerivedKey[] = [];
  const keyFor = (owner: DerivedAddress): DerivedKey => {
    const e = entries.find((x) => x.owner.address === owner.address);
    if (!e) throw new Error(`no key for ${owner.address}`);
    const k = derivedKey(e.key, e.owner);
    handed.push(k);
    return k;
  };
  return { keyFor, handed };
}

export function randomKey(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = btc.utils.randomPrivateKeyBytes();
  return { privateKey, publicKey: secp256k1.getPublicKey(privateKey, true) };
}
