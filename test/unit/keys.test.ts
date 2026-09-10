import { describe, expect, it } from "vitest";
import { WIF } from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  accountPath,
  accountXpub,
  addressFor,
  btcNetworkFor,
  deriveAddress,
  deriveBranchAddresses,
  branchFor,
  deriveKey,
  masterFromEntropy,
  rootXprv,
} from "../../src/keys";
import {
  EXTRA_BRANCHES,
  PURPOSE_FOR_KIND,
  WALLET_BRANCHES,
  WALLET_COIN_TYPE,
  branchKey,
  coinTypeFor,
  walletCoinTypesFor,
  type AddressKind,
  type Network,
} from "../../src/types";
import {
  DESCRIPTOR_WINDOW,
  ELECTRUM_WINDOW,
  FIXTURE_NETWORKS,
  FIXTURE_PURPOSES,
  fixtureCoinTypes,
  loadVectors,
  readDescriptors,
  readElectrum,
  readRootXprv,
  vectorNames,
} from "./keys-fixtures";

const KINDS: AddressKind[] = ["np2wkh", "p2wkh", "p2tr"];
const ALL_NETWORKS: Network[] = ["mainnet", "testnet", "signet", "regtest"];
const KIND_FOR_PURPOSE: Record<49 | 84 | 86, AddressKind> = { 49: "np2wkh", 84: "p2wkh", 86: "p2tr" };

const vectors = loadVectors();
const names = vectorNames();
const entropyOf = (name: string): Uint8Array => {
  const v = vectors.find((x) => x.name === name);
  if (!v) throw new Error(`no aezeed vector named ${name}`);
  return hexToBytes(v.entropy_hex);
};
const wifToHex = (wif: string, network: Network): string =>
  bytesToHex(WIF(btcNetworkFor(network)).decode(wif));

/** Expected address prefixes per network. */
const PREFIX: Record<Network, Record<AddressKind, string>> = {
  mainnet: { np2wkh: "3", p2wkh: "bc1q", p2tr: "bc1p" },
  testnet: { np2wkh: "2", p2wkh: "tb1q", p2tr: "tb1p" },
  signet: { np2wkh: "2", p2wkh: "tb1q", p2tr: "tb1p" },
  regtest: { np2wkh: "2", p2wkh: "bcrt1q", p2tr: "bcrt1p" },
};
const FOREIGN_PREFIXES: Record<Network, RegExp> = {
  mainnet: /^(tb1|bcrt1|2)/,
  testnet: /^(bc1|bcrt1|3)/,
  signet: /^(bc1|bcrt1|3)/,
  regtest: /^(bc1|tb1|3)/,
};

describe("fixtures", () => {
  it("has 7 chantools vectors, all with aezeed entropy", () => {
    expect(names).toHaveLength(7);
    for (const n of names) expect(entropyOf(n)).toHaveLength(16);
  });

  it("covers mainnet (coin 0) and testnet/regtest (coin 0 and 1); signet is absent by design", () => {
    expect(FIXTURE_NETWORKS).toEqual(["mainnet", "testnet", "regtest"]);
    for (const network of FIXTURE_NETWORKS) {
      expect(fixtureCoinTypes(network)).toEqual([...walletCoinTypesFor(network)]);
    }
  });
});

describe("masterFromEntropy / rootXprv", () => {
  it("rejects entropy that is not 16 bytes", () => {
    expect(() => masterFromEntropy(new Uint8Array(15))).toThrow();
    expect(() => masterFromEntropy(new Uint8Array(32))).toThrow();
  });

  it.each(names)("%s: root xprv matches chantools", (name) => {
    const expected = readRootXprv(name);
    for (const network of ALL_NETWORKS) {
      expect(rootXprv(entropyOf(name), network)).toBe(expected);
    }
  });
});

describe("paths and purposes", () => {
  it("maps kinds to BIP purposes and defaults to coin type 0 on every network", () => {
    expect(WALLET_COIN_TYPE).toBe(0);
    for (const network of ALL_NETWORKS) {
      expect(coinTypeFor(network)).toBe(0);
      for (const purpose of [49, 84, 86] as const) {
        expect(accountPath(network, purpose)).toBe(`m/${purpose}'/0'/0'`);
        expect(accountPath(network, purpose, { coinType: 1 })).toBe(`m/${purpose}'/1'/0'`);
      }
      for (const kind of KINDS) {
        expect(branchFor(kind, 0)).toEqual({ purpose: PURPOSE_FOR_KIND[kind], change: 0, kind });
      }
    }
    expect(accountPath("mainnet", 49)).toBe("m/49'/0'/0'");
    expect(accountPath("mainnet", 84)).toBe("m/84'/0'/0'");
    expect(accountPath("mainnet", 86)).toBe("m/86'/0'/0'");
    expect(accountPath("testnet", 84)).toBe("m/84'/0'/0'");
    expect(accountPath("signet", 84)).toBe("m/84'/0'/0'");
    expect(accountPath("regtest", 84)).toBe("m/84'/0'/0'");
    expect(walletCoinTypesFor("mainnet")).toEqual([0]);
    expect(walletCoinTypesFor("regtest")).toEqual([0, 1]);
  });

  it("derived records carry the full path, kind, change and index", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    const a = deriveAddress(master, "signet", branchFor("p2tr", 1), 7);
    expect(a).toMatchObject({ kind: "p2tr", network: "signet", change: 1, index: 7, path: "m/86'/0'/0'/1/7" });
    expect(a.publicKey).toHaveLength(33);
    expect([2, 3]).toContain(a.publicKey[0]);
    expect("privateKey" in a).toBe(false);
  });

  it("guards change, coinType, kind and network at runtime (JS callers bypass the types)", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    const bad = <T>(v: T): never => v as never;
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", bad(2)), 0)).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", bad(-1)), 0)).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", bad("0")), 0)).toThrow(RangeError);
    expect(() => deriveBranchAddresses(master, "mainnet", branchFor("p2wkh", bad(2)), 0, 1)).toThrow(RangeError);
    expect(() => deriveKey(master, "mainnet", branchFor("p2wkh", bad(2)), 0)).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", 0), 0, { coinType: bad(2) })).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", 0), 0, { coinType: bad("0") })).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", branchFor(bad("bogus"), 0), 0)).toThrow(TypeError);
    expect(() => deriveAddress(master, "mainnet", { purpose: 84, change: 0, kind: bad("bogus") }, 0)).toThrow(TypeError);
    expect(() => deriveAddress(master, "mainnet", { purpose: bad(44), change: 0, kind: "p2wkh" }, 0)).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", { purpose: 84, change: bad(2), kind: "p2wkh" }, 0)).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", bad("p2wkh"), 0)).toThrow(TypeError);
    expect(() => deriveAddress(master, bad("mainnet2"), branchFor("p2wkh", 0), 0)).toThrow(TypeError);
    expect(() => accountPath(bad("litecoin"), 84)).toThrow(TypeError);
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", 0), bad("5"))).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", 0), 1.5)).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", 0), Number.NaN)).toThrow(RangeError);
  });

  it("refuses branches lnd never uses unless allowAnyBranch is set", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    const bogus = [
      { purpose: 84, change: 0, kind: "np2wkh" },
      { purpose: 84, change: 1, kind: "p2tr" },
      { purpose: 86, change: 0, kind: "p2wkh" },
      { purpose: 49, change: 0, kind: "p2wkh" },
      { purpose: 49, change: 0, kind: "p2tr" },
      { purpose: 49, change: 1, kind: "p2tr" },
    ] as const;
    for (const b of bogus) {
      expect(() => deriveAddress(master, "mainnet", b, 0)).toThrow(RangeError);
      expect(() => deriveAddress(master, "mainnet", b, 0)).toThrow(`${b.purpose}/${b.change}/${b.kind}`);
      expect(() => deriveKey(master, "mainnet", b, 0)).toThrow(RangeError);
      expect(() => deriveBranchAddresses(master, "mainnet", b, 0, 1)).toThrow(RangeError);
      expect(() => deriveBranchAddresses(master, "mainnet", b, 0, 0)).toThrow(RangeError);
      // Escape hatch for debugging tooling: derives, and labels the result with the branch as given.
      const a = deriveAddress(master, "mainnet", b, 0, { allowAnyBranch: true });
      expect(a).toMatchObject({ purpose: b.purpose, change: b.change, kind: b.kind });
      expect(a.address.startsWith(PREFIX.mainnet[b.kind])).toBe(true);
    }
    // Every real branch is accepted without the flag.
    for (const b of [...WALLET_BRANCHES, ...EXTRA_BRANCHES]) {
      expect(() => deriveAddress(master, "mainnet", b, 0)).not.toThrow();
    }
    expect(WALLET_BRANCHES.length + EXTRA_BRANCHES.length).toBe(7);
  });

  it("deriveKey hands out a fresh private key copy each call; addresses carry no private material", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    const a = deriveKey(master, "mainnet", branchFor("p2wkh", 0), 3);
    const b = deriveKey(master, "mainnet", branchFor("p2wkh", 0), 3);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(bytesToHex(a.privateKey)).toBe(bytesToHex(b.privateKey));
    a.privateKey.fill(0);
    expect(bytesToHex(deriveKey(master, "mainnet", branchFor("p2wkh", 0), 3).privateKey)).toBe(bytesToHex(b.privateKey));
    for (const rec of deriveBranchAddresses(master, "mainnet", branchFor("p2wkh", 0), 0, 3)) {
      expect(Object.keys(rec)).not.toContain("privateKey");
    }
  });

  it("rejects hardened or negative indices", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", 0), -1)).toThrow(RangeError);
    expect(() => deriveAddress(master, "mainnet", branchFor("p2wkh", 0), 0x80000000)).toThrow(RangeError);
    expect(() => deriveBranchAddresses(master, "mainnet", branchFor("p2wkh", 0), 0x7fffffff, 2)).toThrow(RangeError);
    expect(deriveBranchAddresses(master, "mainnet", branchFor("p2wkh", 0), 0, 0)).toEqual([]);
  });

  it("accountXpub is a mainnet-versioned xpub for every network", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    for (const network of ALL_NETWORKS) {
      for (const purpose of [49, 84, 86] as const) expect(accountXpub(master, network, purpose)).toMatch(/^xpub/);
    }
  });
});

describe("chantools descriptors: keys and addresses, both branches, 25 indices, every coin type", () => {
  const cases = names.flatMap((name) =>
    FIXTURE_NETWORKS.flatMap((network) =>
      fixtureCoinTypes(network).flatMap((coinType) =>
        FIXTURE_PURPOSES.map((purpose) => [name, network, purpose, coinType] as const),
      ),
    ),
  );

  it.each(cases)("%s %s m/%d' coin %d", (name, network, purpose, coinType) => {
    const master = masterFromEntropy(entropyOf(name));
    const kind = KIND_FOR_PURPOSE[purpose];
    const entries = readDescriptors(name, network, purpose, coinType);
    expect(entries).toHaveLength(2 * DESCRIPTOR_WINDOW);
    // Coin 0 is lnd's wallet default on every network: exercise the no-override path for it.
    const opts = coinType === WALLET_COIN_TYPE ? undefined : { coinType };

    for (const change of [0, 1] as const) {
      const branch = deriveBranchAddresses(master, network, branchFor(kind, change), 0, DESCRIPTOR_WINDOW, opts);
      expect(branch).toHaveLength(DESCRIPTOR_WINDOW);
      for (const e of entries.filter((x) => x.change === change)) {
        const key = deriveKey(master, network, branchFor(kind, change), e.index, opts);
        const addr = branch[e.index]!;

        // Private key (WIF is network-prefixed, so this also checks chantools used the right params).
        expect(bytesToHex(key.privateKey)).toBe(wifToHex(e.wif, network));

        // The address of this kind at this path.
        expect(addr.address).toBe(e.address[kind]);
        expect(addr.path).toBe(`m/${purpose}'/${coinType}'/0'/${change}/${e.index}`);
        expect(addr.path).toBe(key.path);
        expect(bytesToHex(addr.publicKey)).toBe(bytesToHex(key.publicKey));
        expect(addr.address).toBe(key.address);

        // chantools also labels the same key in the other two encodings: check all three.
        for (const k of KINDS) {
          expect(addressFor(key.publicKey, network, k).address).toBe(e.address[k]);
        }

        // lnd's real branch for m/49'/…/1/i is native P2WPKH (btcwallet BIP0049Plus internal).
        if (purpose === 49 && change === 1) {
          const lndBranch = WALLET_BRANCHES.find((b) => b.purpose === 49 && b.change === 1)!;
          expect(lndBranch.kind).toBe("p2wkh");
          const a = deriveAddress(master, network, lndBranch, e.index, opts);
          expect(a.address).toBe(e.address.p2wkh);
          expect(a).toMatchObject({ kind: "p2wkh", purpose: 49, change: 1, path: key.path });
          const k = deriveKey(master, network, lndBranch, e.index, opts);
          expect(bytesToHex(k.privateKey)).toBe(wifToHex(e.wif, network));
          expect(k.address).toBe(e.address.p2wkh);
        }
      }
    }
  });

  it("every WALLET_BRANCH and EXTRA_BRANCH derives, with purpose and kind from the branch", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    const seen = new Set<string>();
    for (const branch of [...WALLET_BRANCHES, ...EXTRA_BRANCHES]) {
      const [a] = deriveBranchAddresses(master, "mainnet", branch, 0, 1);
      expect(a).toMatchObject({ purpose: branch.purpose, change: branch.change, kind: branch.kind });
      expect(a!.path).toBe(`m/${branch.purpose}'/0'/0'/${branch.change}/0`);
      expect(a!.address.startsWith(PREFIX.mainnet[branch.kind])).toBe(true);
      expect(seen.has(a!.address)).toBe(false);
      seen.add(a!.address);
      expect(branchKey(branch)).toBe(`${branch.purpose}/${branch.change}/${branch.kind}`);
    }
    // 49/1 as p2wkh (lnd) and as np2wkh (extra) share the key, differ only in encoding.
    const wallet = deriveAddress(master, "mainnet", { purpose: 49, change: 1, kind: "p2wkh" }, 5);
    const extra = deriveAddress(master, "mainnet", { purpose: 49, change: 1, kind: "np2wkh" }, 5);
    expect(bytesToHex(wallet.publicKey)).toBe(bytesToHex(extra.publicKey));
    expect(wallet.path).toBe(extra.path);
    expect(wallet.address).toMatch(/^bc1q/);
    expect(extra.address).toMatch(/^3/);
  });

  it("regression: e2e scenario D, lnd NextAddr(NESTED, change=true) on regtest is native P2WPKH at m/49'/0'/0'/1/i", () => {
    // Seed 21bc0fca…: lnd returned these for nested change addresses and listunspent showed WITNESS_PUBKEY_HASH.
    const master = masterFromEntropy(hexToBytes("21bc0fca72fe4919a2fbe3633804a5ab"));
    const lnd = { purpose: 49, change: 1, kind: "p2wkh" } as const;
    const addrs = deriveBranchAddresses(master, "regtest", lnd, 0, 4).map((a) => a.address);
    expect(addrs).toEqual([
      "bcrt1qdscws5660ujh5v0wmqkll9ztkesl7qevsacsxs",
      "bcrt1qrnyqvjm72m46wf8p0ldjqtg25sjceq99ga6n5d",
      "bcrt1qa6um4yg332ef4g0m0dy8r7syzhvckr25qr02kd",
      "bcrt1qfkf9w7v0yl35g4may2pkvw64fmgayh0cqsvcmk",
    ]);
    // The P2SH encodings of the same keys are the belt-and-braces EXTRA branch, not what lnd used.
    const extra = deriveBranchAddresses(master, "regtest", { purpose: 49, change: 1, kind: "np2wkh" }, 0, 2);
    expect(extra.map((a) => a.address)).toEqual([
      "2NAN6tDVdRFXQtKqpnb8koDvRCqS77nddFR",
      "2Muwv3jiFWEQRUubh6R3id5D55zP2dq1wio",
    ]);
    // And the signing key for the lnd address pays to its script.
    const k = deriveKey(master, "regtest", lnd, 0);
    expect(k.address).toBe(addrs[0]);
    expect(k.scriptPubKey[0]).toBe(0x00);
    expect(k.scriptPubKey).toHaveLength(22);
  });

  it("coin 0 and coin 1 derive disjoint key sets off mainnet", () => {
    for (const network of ["testnet", "regtest"] as const) {
      const c0 = readDescriptors(names[0]!, network, 84, 0).map((e) => e.wif);
      const c1 = readDescriptors(names[0]!, network, 84, 1).map((e) => e.wif);
      expect(c0.some((w) => c1.includes(w))).toBe(false);
    }
  });
});

describe("chantools --lndpaths electrum dump (coin type 0 on every network, default derivation)", () => {
  const cases = names.flatMap((name) => FIXTURE_NETWORKS.map((network) => [name, network] as const));

  it.each(cases)("%s %s", (name, network) => {
    const master = masterFromEntropy(entropyOf(name));
    const entries = readElectrum(name, network);
    expect(entries).toHaveLength(3 * 2 * ELECTRUM_WINDOW);
    for (const e of entries) {
      const kind = KIND_FOR_PURPOSE[e.purpose];
      expect(e.scriptType).toBe(e.purpose === 49 ? "p2wpkh-p2sh" : "p2wpkh");
      const key = deriveKey(master, network, branchFor(kind, e.change), e.index);
      expect(bytesToHex(key.privateKey)).toBe(wifToHex(e.wif, network));
      expect(key.path).toBe(`m/${e.purpose}'/0'/0'/${e.change}/${e.index}`);
    }
  });

  it("the coin 1 override derives different keys from the coin 0 dump", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    for (const network of FIXTURE_NETWORKS) {
      const first = readElectrum(names[0]!, network)[0]!;
      const key = deriveKey(master, network, branchFor("np2wkh", 0), 0, { coinType: 1 });
      expect(bytesToHex(key.privateKey)).not.toBe(wifToHex(first.wif, network));
    }
  });
});

describe("network prefixes", () => {
  it.each(ALL_NETWORKS)("%s addresses use only that network's prefixes", (network) => {
    for (const name of names) {
      const master = masterFromEntropy(entropyOf(name));
      for (const kind of KINDS) {
        for (const change of [0, 1] as const) {
          for (const a of deriveBranchAddresses(master, network, branchFor(kind, change), 0, 5)) {
            expect(a.address.startsWith(PREFIX[network][kind])).toBe(true);
            expect(a.address).not.toMatch(FOREIGN_PREFIXES[network]);
          }
        }
      }
    }
  });

  it("testnet and signet share encoding; regtest differs only in bech32 hrp", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    const t = deriveAddress(master, "testnet", branchFor("p2wkh", 0), 0);
    const s = deriveAddress(master, "signet", branchFor("p2wkh", 0), 0);
    const r = deriveAddress(master, "regtest", branchFor("p2wkh", 0), 0);
    expect(t.address).toBe(s.address);
    expect(bytesToHex(t.scriptPubKey)).toBe(bytesToHex(r.scriptPubKey));
    expect(r.address).not.toBe(t.address);
  });

  it("scriptPubKey shape per kind", () => {
    const master = masterFromEntropy(entropyOf(names[0]!));
    const np = deriveAddress(master, "mainnet", branchFor("np2wkh", 0), 0).scriptPubKey;
    const wp = deriveAddress(master, "mainnet", branchFor("p2wkh", 0), 0).scriptPubKey;
    const tr = deriveAddress(master, "mainnet", branchFor("p2tr", 0), 0).scriptPubKey;
    expect(np).toHaveLength(23);
    expect(np[0]).toBe(0xa9); // OP_HASH160
    expect(wp).toHaveLength(22);
    expect(wp[0]).toBe(0x00); // OP_0
    expect(tr).toHaveLength(34);
    expect(tr[0]).toBe(0x51); // OP_1
  });
});

describe("batching and throughput", () => {
  it("deriveBranch matches deriveAddress element-wise", () => {
    const master = masterFromEntropy(entropyOf(names[1]!));
    const batch = deriveBranchAddresses(master, "mainnet", branchFor("p2tr", 1), 10, 20);
    expect(batch).toHaveLength(20);
    batch.forEach((a, i) => expect(a).toEqual(deriveAddress(master, "mainnet", branchFor("p2tr", 1), 10 + i)));
  });

  it("derives a 2500-deep branch quickly (measured)", () => {
    const master = masterFromEntropy(entropyOf(names[2]!));
    const depth = 2500;
    const rates: string[] = [];
    for (const kind of KINDS) {
      const t0 = performance.now();
      const out = deriveBranchAddresses(master, "mainnet", branchFor(kind, 0), 0, depth);
      const ms = performance.now() - t0;
      expect(out).toHaveLength(depth);
      expect(new Set(out.map((a) => a.address)).size).toBe(depth);
      rates.push(`${kind}: ${Math.round((depth / ms) * 1000)} addr/s (${ms.toFixed(0)} ms)`);
      expect(ms).toBeLessThan(20_000);
    }
    console.info(`[keys] 2500-deep branch throughput: ${rates.join(", ")}`);
  }, 60_000);
});
