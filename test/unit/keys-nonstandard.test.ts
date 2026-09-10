/**
 * lnd derives its wallet keys with btcd's hdkeychain.DeriveNonStandard, which
 * serialises the parent private key without left padding at hardened levels.
 * For seeds whose m/purpose' or m/purpose'/coin' key has leading zero bytes,
 * every address of that purpose differs from standard BIP32. These fixtures
 * (chantools v0.14.2 derivekey + genimportscript) pin the lnd behaviour.
 */
import { describe, expect, it } from "vitest";
import { HARDENED_OFFSET, HDKey } from "@scure/bip32";
import { WIF } from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { numberToBytesBE } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  accountXpub,
  childTweak,
  deriveHardenedStandard,
  addressFor,
  btcNetworkFor,
  deriveAddress,
  deriveBranchAddresses,
  branchFor,
  deriveHardenedNonStandard,
  deriveKey,
  masterFromEntropy,
  rootXprv,
} from "../../src/keys";
import type { AddressKind, Network } from "../../src/types";

interface NonStandardCase {
  network: Network;
  coin: 0 | 1;
  purpose: 49 | 84 | 86;
  change: 0 | 1;
  index: number;
  path: string;
  pubkey: string;
  wif: string;
  p2wkh: string;
  p2tr: string;
  np2wkh?: string;
}
interface NonStandardFixture {
  entropy: string;
  rootXprv: string;
  /** Set on the control fixture whose master key (not any purpose/coin key) has leading zeros. */
  masterLeadingZeroBytes?: number;
  shortKeys: { path: string; leadingZeroBytes: number }[];
  cases: NonStandardCase[];
}

const FIXTURES = import.meta.glob("../fixtures/chantools/nonstandard-*.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const fixtures = Object.entries(FIXTURES)
  .map(([file, text]) => [file.replace(/^.*\//, ""), JSON.parse(text) as NonStandardFixture] as const)
  .sort(([a], [b]) => a.localeCompare(b));

const KIND_FOR_PURPOSE: Record<49 | 84 | 86, AddressKind> = { 49: "np2wkh", 84: "p2wkh", 86: "p2tr" };
const wifToHex = (wif: string, network: Network): string => bytesToHex(WIF(btcNetworkFor(network)).decode(wif));

describe("non-standard fixture set", () => {
  it("has at least 3 affected seeds and covers every purpose at both hardened levels", () => {
    expect(fixtures.filter(([, f]) => f.shortKeys.length > 0).length).toBeGreaterThanOrEqual(3);
    const covered = new Set(fixtures.flatMap(([, f]) => f.shortKeys.map((k) => k.path)));
    for (const p of [49, 84, 86]) {
      expect(covered.has(`m/${p}'`)).toBe(true);
      expect(covered.has(`m/${p}'/0'`) || covered.has(`m/${p}'/1'`)).toBe(true);
    }
    // At least one key that is two bytes short, and one seed with coin 1 cases.
    expect(fixtures.some(([, f]) => f.shortKeys.some((k) => k.leadingZeroBytes >= 2))).toBe(true);
    expect(fixtures.some(([, f]) => f.cases.some((c) => c.coin === 1))).toBe(true);
  });

  it("shortKeys metadata matches standard BIP32 on the recorded paths", () => {
    for (const [, f] of fixtures) {
      const master = HDKey.fromMasterSeed(hexToBytes(f.entropy));
      if (f.masterLeadingZeroBytes !== undefined) {
        expect(master.privateKey!.findIndex((b) => b !== 0)).toBe(f.masterLeadingZeroBytes);
      } else {
        expect(f.shortKeys.length).toBeGreaterThan(0);
      }
      for (const k of f.shortKeys) {
        const node = master.derive(k.path);
        expect(node.privateKey!.findIndex((b) => b !== 0)).toBe(k.leadingZeroBytes);
      }
    }
  });
});

describe.each(fixtures)("%s", (_file, f) => {
  const entropy = hexToBytes(f.entropy);
  const master = masterFromEntropy(entropy);

  it("root xprv matches", () => {
    expect(rootXprv(entropy, "mainnet")).toBe(f.rootXprv);
  });

  it.each(f.cases.map((c) => [c.path, c.network, c] as const))("%s %s", (_path, network, c) => {
    const kind = KIND_FOR_PURPOSE[c.purpose];
    const opts = { coinType: c.coin };
    const key = deriveKey(master, network, branchFor(kind, c.change), c.index, opts);
    const addr = deriveAddress(master, network, branchFor(kind, c.change), c.index, opts);
    const [batch] = deriveBranchAddresses(master, network, branchFor(kind, c.change), c.index, 1, opts);

    expect(key.path).toBe(c.path);
    expect(bytesToHex(key.publicKey)).toBe(c.pubkey);
    expect(bytesToHex(key.privateKey)).toBe(wifToHex(c.wif, network));
    expect(addressFor(key.publicKey, network, "p2wkh").address).toBe(c.p2wkh);
    expect(addressFor(key.publicKey, network, "p2tr").address).toBe(c.p2tr);
    if (c.np2wkh) expect(addressFor(key.publicKey, network, "np2wkh").address).toBe(c.np2wkh);
    expect(key.address).toBe({ np2wkh: c.np2wkh ?? key.address, p2wkh: c.p2wkh, p2tr: c.p2tr }[kind]);
    expect(addr.address).toBe(key.address);
    expect(bytesToHex(addr.publicKey)).toBe(c.pubkey);
    expect(batch!.address).toBe(key.address);

    // lnd's real m/49' internal branch is native P2WPKH; chantools prints the wpkh address for every key.
    if (c.purpose === 49 && c.change === 1) {
      const lnd = deriveAddress(master, network, { purpose: 49, change: 1, kind: "p2wkh" }, c.index, opts);
      expect(lnd.address).toBe(c.p2wkh);
      expect(lnd).toMatchObject({ purpose: 49, kind: "p2wkh", path: c.path });
    }
  });

  it("standard BIP32 differs exactly on the affected purposes (the fixture exercises the bug)", () => {
    const std = HDKey.fromMasterSeed(entropy);
    for (const c of f.cases) {
      const affected = f.shortKeys.some(
        (k) => k.path === `m/${c.purpose}'` || k.path === `m/${c.purpose}'/${c.coin}'`,
      );
      const stdPub = bytesToHex(std.derive(c.path).publicKey!);
      if (affected) expect(stdPub).not.toBe(c.pubkey);
      else expect(stdPub).toBe(c.pubkey);
    }
  });

  it("account xpub differs from standard BIP32 on affected accounts only", () => {
    const std = HDKey.fromMasterSeed(entropy);
    for (const purpose of [49, 84, 86] as const) {
      for (const coin of [0, 1] as const) {
        const affected = f.shortKeys.some((k) => k.path === `m/${purpose}'` || k.path === `m/${purpose}'/${coin}'`);
        const ours = accountXpub(master, "mainnet", purpose, { coinType: coin });
        const theirs = std.derive(`m/${purpose}'/${coin}'/0'`).publicExtendedKey;
        if (affected) expect(ours).not.toBe(theirs);
        else expect(ours).toBe(theirs);
      }
    }
  });
});

describe("deriveHardenedNonStandard", () => {
  it("equals standard BIP32 whenever the parent key has no leading zero byte", () => {
    let checked = 0;
    for (let n = 0; checked < 200; n++) {
      const seed = sha256(new TextEncoder().encode(`nonstd-equivalence-${n}`)).subarray(0, 16);
      const parent = HDKey.fromMasterSeed(seed).deriveChild(HARDENED_OFFSET + 84);
      if (parent.privateKey![0] === 0) continue;
      const a = deriveHardenedNonStandard(parent, 0);
      const b = parent.deriveChild(HARDENED_OFFSET);
      expect(a.privateExtendedKey).toBe(b.privateExtendedKey);
      expect(a.publicExtendedKey).toBe(b.publicExtendedKey);
      checked++;
    }
  });

  it("differs from standard BIP32 exactly when the parent key has a leading zero byte", () => {
    const [, f] = fixtures.find(([, x]) => x.shortKeys.some((k) => /^m\/\d+'$/.test(k.path)))!;
    const short = f.shortKeys.find((k) => /^m\/\d+'$/.test(k.path))!;
    const parent = HDKey.fromMasterSeed(hexToBytes(f.entropy)).derive(short.path);
    expect(parent.privateKey![0]).toBe(0);
    expect(deriveHardenedNonStandard(parent, 0).publicExtendedKey).not.toBe(
      parent.deriveChild(HARDENED_OFFSET).publicExtendedKey,
    );
  });

  it("master step: padded (standard) serialisation is what btcd uses, minimal would diverge", () => {
    // Seeds whose master key has a leading zero byte: NewMaster keeps all 32 bytes, so the
    // purpose' step equals standard BIP32 (pinned by nonstandard-master-zero.json above).
    let checked = 0;
    for (let n = 0; checked < 5; n++) {
      const seed = sha256(new TextEncoder().encode(`master-zero-${n}`)).subarray(0, 16);
      const master = HDKey.fromMasterSeed(seed);
      if (master.privateKey![0] !== 0) continue;
      const std = master.deriveChild(HARDENED_OFFSET + 84).publicExtendedKey;
      expect(deriveHardenedStandard(master, 84).publicExtendedKey).toBe(std);
      expect(deriveHardenedNonStandard(master, 84).publicExtendedKey).not.toBe(std);
      checked++;
    }
  });

  it("deriveHardenedStandard equals HDKey.deriveChild on random parents", () => {
    for (let n = 0; n < 50; n++) {
      const parent = HDKey.fromMasterSeed(sha256(new TextEncoder().encode(`std-${n}`)).subarray(0, 16));
      const a = deriveHardenedStandard(parent, n);
      expect(a.privateExtendedKey).toBe(parent.deriveChild(HARDENED_OFFSET + n).privateExtendedKey);
    }
  });

  it("rejects public-only parents and non-hardened-range indices", () => {
    const priv = HDKey.fromMasterSeed(new Uint8Array(16).fill(1));
    const pub = HDKey.fromExtendedKey(priv.publicExtendedKey);
    expect(() => deriveHardenedNonStandard(pub, 0)).toThrow();
    expect(() => deriveHardenedStandard(pub, 0)).toThrow();
    expect(() => deriveHardenedNonStandard(priv, -1)).toThrow(RangeError);
    expect(() => deriveHardenedNonStandard(priv, HARDENED_OFFSET)).toThrow(RangeError);
  });
});

describe("childTweak: a bad IL throws instead of retrying at index+1", () => {
  const n = secp256k1.Point.Fn.ORDER;
  const withIL = (il: bigint): Uint8Array => {
    const I = new Uint8Array(64);
    I.set(numberToBytesBE(il, 32), 0);
    I.fill(0xaa, 32);
    return I;
  };
  it("accepts 1 and n-1", () => {
    expect(childTweak(withIL(1n))).toBe(1n);
    expect(childTweak(withIL(n - 1n))).toBe(n - 1n);
  });
  it("rejects 0, n and n+1 with RangeError", () => {
    expect(() => childTweak(withIL(0n))).toThrow(RangeError);
    expect(() => childTweak(withIL(n))).toThrow(RangeError);
    expect(() => childTweak(withIL(n + 1n))).toThrow(RangeError);
    expect(() => childTweak(new Uint8Array(32))).toThrow(RangeError);
  });
});
