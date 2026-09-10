/**
 * Parsers for the chantools v0.14.2 genimportscript fixtures in
 * test/fixtures/chantools. Test-only helper, no assertions here.
 */
import type { AddressKind, Network } from "../../src/types";

// Raw fixture text bundled by Vite; keys are paths relative to this file.
const FIXTURES = import.meta.glob("../fixtures/chantools/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const VECTORS_JSON = import.meta.glob("../fixtures/aezeed-vectors.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function readFixture(name: string): string {
  const text = FIXTURES[`../fixtures/chantools/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text;
}

function fixtureNames(): string[] {
  return Object.keys(FIXTURES).map((k) => k.replace(/^.*\//, ""));
}

/** Networks chantools was run on. Signet is absent (chantools 0.14.2 panics on it); it shares testnet encoding. */
export const FIXTURE_NETWORKS: Network[] = ["mainnet", "testnet", "regtest"];

export const FIXTURE_PURPOSES = [49, 84, 86] as const;
export const DESCRIPTOR_WINDOW = 25;
export const ELECTRUM_WINDOW = 5;

/** Coin types with descriptors fixtures on a network: mainnet has coin 0 only, others have coin 0 and 1. */
export function fixtureCoinTypes(network: Network): (0 | 1)[] {
  return network === "mainnet" ? [0] : [0, 1];
}

export interface AezeedVector {
  name: string;
  entropy_hex: string;
  salt_hex: string;
  passphrase: string;
  birthday_days: number;
  internal_version: number;
  enciphered_hex: string;
  mnemonic: string[];
}

export function loadVectors(): AezeedVector[] {
  const text = Object.values(VECTORS_JSON)[0];
  if (!text) throw new Error("missing aezeed-vectors.json");
  return JSON.parse(text) as AezeedVector[];
}

export function vectorNames(): string[] {
  return fixtureNames()
    .filter((f) => f.endsWith(".rootkey.txt"))
    .map((f) => f.replace(/\.rootkey\.txt$/, ""))
    .sort();
}

export function readRootXprv(vector: string): string {
  const text = readFixture(`${vector}.rootkey.txt`);
  const m = /\b(xprv[1-9A-HJ-NP-Za-km-z]{100,120})\b/.exec(text);
  if (!m?.[1]) throw new Error(`no xprv in ${vector}.rootkey.txt`);
  return m[1];
}

/** One `bitcoin-cli importdescriptors` line: a single key with its three address encodings. */
export interface DescriptorEntry {
  change: 0 | 1;
  index: number;
  wif: string;
  address: Record<AddressKind, string>;
}

const DESC_LINE = /^bitcoin-cli importdescriptors '(\[.*\])'$/;
const DESC_KEY = /^(sh\(wpkh\(|wpkh\(|tr\()([1-9A-HJ-NP-Za-km-z]+)\)+#[0-9a-z]{8}$/;

/** Descriptors fixture file name; off-mainnet files carry a coin-type suffix. */
export function descriptorsFile(vector: string, network: Network, purpose: 49 | 84 | 86, coinType: 0 | 1): string {
  const coin = network === "mainnet" ? "" : `.coin${coinType}`;
  return `${vector}.${network}.${purpose}${coin}.descriptors.txt`;
}

/**
 * Parse a descriptors file. chantools writes the external branch first
 * (0..window-1) then the internal branch (0..window-1); see
 * chantools/btc/bitcoind.go ExportKeys.
 */
export function readDescriptors(
  vector: string,
  network: Network,
  purpose: 49 | 84 | 86,
  coinType: 0 | 1,
): DescriptorEntry[] {
  if (network === "mainnet" && coinType !== 0) throw new Error("mainnet fixtures exist for coin type 0 only");
  const file = descriptorsFile(vector, network, purpose, coinType);
  const lines = readFixture(file).split("\n");
  const entries: DescriptorEntry[] = [];
  for (const line of lines) {
    const m = DESC_LINE.exec(line);
    if (!m?.[1]) continue;
    const items = JSON.parse(m[1]) as { desc: string; label: string }[];
    if (items.length !== 3) throw new Error(`expected 3 descriptors per line in ${file}`);
    const kinds: AddressKind[] = ["np2wkh", "p2wkh", "p2tr"];
    const prefixes = ["sh(wpkh(", "wpkh(", "tr("];
    const address = {} as Record<AddressKind, string>;
    let wif: string | undefined;
    items.forEach((item, i) => {
      const km = DESC_KEY.exec(item.desc);
      if (!km || km[1] !== prefixes[i]) throw new Error(`unexpected descriptor ${item.desc} in ${file}`);
      if (wif === undefined) wif = km[2];
      else if (wif !== km[2]) throw new Error(`mixed keys on one line in ${file}`);
      address[kinds[i]!] = item.label;
    });
    if (!wif) throw new Error(`no key in line of ${file}`);
    const n = entries.length;
    entries.push({
      change: n < DESCRIPTOR_WINDOW ? 0 : 1,
      index: n % DESCRIPTOR_WINDOW,
      wif,
      address,
    });
  }
  if (entries.length !== 2 * DESCRIPTOR_WINDOW) {
    throw new Error(`expected ${2 * DESCRIPTOR_WINDOW} descriptor lines in ${file}, got ${entries.length}`);
  }
  return entries;
}

export interface ElectrumEntry {
  purpose: 49 | 84 | 86;
  change: 0 | 1;
  index: number;
  /** Electrum script type prefix chantools chose: p2wpkh-p2sh for m/49', p2wpkh otherwise. */
  scriptType: "p2wpkh-p2sh" | "p2wpkh";
  wif: string;
}

/**
 * Parse an `--lndpaths` electrum dump (window 5). chantools' AllDerivationPaths
 * emits m/49'/0'/0', m/84'/0'/0', m/86'/0'/0' (coin type 0 on EVERY network) and
 * then m/1017'/coin'/9' for the node's payment base keys, each as external
 * then internal branch. The 1017' keys are not wallet addresses and are dropped.
 */
export function readElectrum(vector: string, network: Network): ElectrumEntry[] {
  const file = `${vector}.${network}.lndpaths.electrum.txt`;
  const lines = readFixture(file).split("\n");
  const raw: { scriptType: "p2wpkh-p2sh" | "p2wpkh"; wif: string }[] = [];
  for (const line of lines) {
    const m = /^(p2wpkh-p2sh|p2wpkh):([1-9A-HJ-NP-Za-km-z]+)$/.exec(line);
    if (m?.[1] && m[2]) raw.push({ scriptType: m[1] as "p2wpkh-p2sh" | "p2wpkh", wif: m[2] });
  }
  const perPath = 2 * ELECTRUM_WINDOW;
  if (raw.length !== 4 * perPath) throw new Error(`expected ${4 * perPath} keys in ${file}, got ${raw.length}`);
  const out: ElectrumEntry[] = [];
  FIXTURE_PURPOSES.forEach((purpose, p) => {
    for (let n = 0; n < perPath; n++) {
      const r = raw[p * perPath + n]!;
      out.push({
        purpose,
        change: n < ELECTRUM_WINDOW ? 0 : 1,
        index: n % ELECTRUM_WINDOW,
        scriptType: r.scriptType,
        wif: r.wif,
      });
    }
  });
  return out;
}
