/**
 * End-to-end: a real lnd on regtest is funded on all three address types with
 * change on the internal branches (including WalletKit NextAddr nested
 * change=true addresses, which btcwallet encodes as native P2WPKH on the
 * m/49' internal branch), then killed and wiped. Recovery must come from the
 * 24 words alone, through the Esplora-compatible shim, and sweep everything to
 * a fresh bitcoind address at the fee rate the shim reports.
 *
 *   pnpm test:e2e
 *
 * Needs bitcoind, bitcoin-cli, lnd, lncli (or BITCOIND_BIN, LND_BIN, LNCLI_BIN)
 * and chantools (CHANTOOLS_BIN or PATH). Output never includes seed words; the
 * entropy hex identifies a run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { HDKey } from "@scure/bip32";
import type { AddressKind, ScanResult, SignedSweep } from "../../src/types";
import { EXTRA_BRANCHES, PURPOSE_FOR_KIND, WALLET_BRANCHES } from "../../src/types";
import { decipherMnemonic, InvalidPassphraseError } from "../../src/aezeed";
import { accountNode, deriveBranchAddresses, masterFromEntropy } from "../../src/keys";
import { DEFAULT_RATE_PER_SECOND, SCAN_TIERS, ScanError, estimateScanCost, scan } from "../../src/chain";
import { planSweep, signSweep } from "../../src/tx";
import { start as startShim, type Shim } from "./esplora-shim";
import { startBitcoind, type Bitcoind } from "./harness/bitcoind";
import { startLnd, type Lnd, type LndUtxo } from "./harness/lnd";
import { ADDRESSES_PER_KIND, FUNDED_INDICES, KINDS, fundLnd, spendFromEachKind, type Funded } from "./harness/scenario";
import { genImportScript, showRootKey, type ChantoolsAddresses } from "./harness/chantools";
import { SHIM_FEE_RATE } from "./harness/up";
import {
  NETWORK,
  branchLabel,
  branchOf,
  chantoolsBranch,
  clientFor,
  coinTypeOfPath,
  deriverFor,
  fastestFeeRate,
  hex,
  keyFor,
  measured,
  outpoints,
} from "./harness/recovery";
import { freePort } from "./harness/util";
import vectors from "../fixtures/aezeed-vectors.json";

const CHANTOOLS_WINDOW = 25;
const NESTED_CHANGE_COUNT = 2;
const [TIER_1, TIER_2] = SCAN_TIERS as readonly [100, 2500];

interface State {
  bitcoind?: Bitcoind;
  lnd?: Lnd;
  shim?: Shim;
  mnemonic: string[];
  passphrase: string | undefined;
  entropyHex: string;
  externalAddresses: Record<AddressKind, string[]>;
  funded: Funded[];
  nestedChange: Funded[];
  fundedTotalSats: number;
  spentBackSats: number;
  /** lnd's own view just before it dies. */
  lndUtxos: LndUtxo[];
  lndConfirmedSats: number;
  changeAddresses: string[];
  chantools?: ChantoolsAddresses;
  master?: HDKey;
  /** Tier-1 (window 100) result. */
  scan100?: ScanResult;
  /** Tier-2 (window 2500) result, resumed from scan100. */
  scan?: ScanResult;
  sweep?: SignedSweep;
  tier1?: { ms: number; requests: number };
  tier2?: { ms: number; requests: number; predicted: number };
  resumeMs?: number;
}

const S: State = {
  mnemonic: [],
  passphrase: undefined,
  entropyHex: "",
  externalAddresses: { p2wkh: [], np2wkh: [], p2tr: [] },
  funded: [],
  nestedChange: [],
  fundedTotalSats: 0,
  spentBackSats: 0,
  lndUtxos: [],
  lndConfirmedSats: 0,
  changeAddresses: [],
};

async function getMaster(): Promise<HDKey> {
  if (S.master) return S.master;
  const seed = await decipherMnemonic(S.mnemonic, S.passphrase ?? "");
  S.entropyHex = hex(seed.entropy);
  S.master = masterFromEntropy(seed.entropy);
  return S.master;
}

async function ensureShim(): Promise<Shim> {
  if (S.shim) return S.shim;
  const bd = S.bitcoind!;
  S.shim = await startShim({
    rpcUrl: bd.rpcUrl,
    cookiePath: bd.cookiePath,
    port: await freePort(),
    host: "127.0.0.1",
    feeRateSatPerVb: SHIM_FEE_RATE,
  });
  return S.shim;
}

describe("lnd seed recovery on regtest", () => {
  beforeAll(async () => {
    S.bitcoind = await startBitcoind();
    await S.bitcoind.mine(110);
    S.lnd = await startLnd({ bitcoind: S.bitcoind });
    S.mnemonic = S.lnd.mnemonic;
    S.passphrase = S.lnd.aezeedPassphrase;
    await S.lnd.waitSynced();
    await getMaster();
    console.log(`[e2e] fresh lnd seed, entropy ${S.entropyHex}`);
  });

  afterAll(async () => {
    const errors: string[] = [];
    const tryDo = async (what: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    if (S.lnd) {
      await tryDo("kill lnd", () => S.lnd!.kill());
      await tryDo("delete lnddir", () => S.lnd!.deleteDataDir());
    }
    if (S.shim) await tryDo("stop shim", () => S.shim!.stop());
    if (S.bitcoind) await tryDo("stop bitcoind", () => S.bitcoind!.stop());

    const rows: [string, string][] = [
      ["seed entropy", S.entropyHex || "n/a"],
      ["funded (sats)", String(S.fundedTotalSats)],
      ["of which nested change=true (sats)", String(S.nestedChange.reduce((n, f) => n + f.sats, 0))],
      ["sent back to bitcoind (sats)", String(S.spentBackSats)],
      ["lnd confirmed before death (sats)", String(S.lndConfirmedSats)],
      ["lnd utxos", String(S.lndUtxos.length)],
      ["recovered at tier 100 (sats)", S.scan100 ? String(S.scan100.totalSats) : "n/a"],
      ["recovered at tier 2500 (sats)", S.scan ? String(S.scan.totalSats) : "n/a"],
      ["recovered utxos", S.scan ? String(S.scan.utxos.length) : "n/a"],
      [
        "tier 100 wall time / requests",
        S.tier1 ? `${(S.tier1.ms / 1000).toFixed(1)} s / ${S.tier1.requests} (${(S.tier1.requests / (S.tier1.ms / 1000)).toFixed(0)} req/s on the shim; pacer default ${DEFAULT_RATE_PER_SECOND}/s)` : "n/a",
      ],
      [
        "tier 2500 incremental time / requests",
        S.tier2 ? `${(S.tier2.ms / 1000).toFixed(1)} s / ${S.tier2.requests} (estimateScanCost predicted ${S.tier2.predicted})` : "n/a",
      ],
      ["abort + resume time (tier 100)", S.resumeMs !== undefined ? `${(S.resumeMs / 1000).toFixed(1)} s` : "n/a"],
      ["swept (sats)", S.sweep ? String(S.sweep.outputSats) : "n/a"],
      ["fee (sats)", S.sweep ? String(S.sweep.feeSats) : "n/a"],
      ["fee rate asked (sat/vB)", S.sweep ? S.sweep.feeRateSatPerVb.toFixed(2) : "n/a"],
      ["fee rate effective (sat/vB)", S.sweep ? (S.sweep.feeSats / S.sweep.vsize).toFixed(3) : "n/a"],
      ["vsize (vB)", S.sweep ? String(S.sweep.vsize) : "n/a"],
      ["sweep txid", S.sweep?.txid ?? "n/a"],
    ];
    const w = Math.max(...rows.map((r) => r[0].length));
    console.log("\n[e2e] summary\n" + rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`).join("\n") + "\n");
    if (errors.length) console.error("[e2e] cleanup problems:\n  " + errors.join("\n  "));
  });

  it("1. starts bitcoind and lnd with a real 24-word aezeed", async () => {
    expect(await S.bitcoind!.blockHeight()).toBeGreaterThanOrEqual(110);
    expect(S.mnemonic).toHaveLength(24);
    expect(S.entropyHex).toMatch(/^[0-9a-f]{32}$/);
    const info = await S.lnd!.getInfo();
    expect(info.synced_to_chain).toBe(true);
    expect((await S.lnd!.walletBalance()).confirmedSat).toBe(0);
  });

  it("2a. funds several addresses of each kind at non-sequential indices, plus nested change=true addresses", async () => {
    const lnd = S.lnd!;
    const funding = await fundLnd(S.bitcoind!, lnd, { nestedChangeCount: NESTED_CHANGE_COUNT });
    S.externalAddresses = funding.externalAddresses;
    S.funded = funding.funded;
    S.nestedChange = funding.nestedChange;
    S.fundedTotalSats = funding.fundedTotalSats;
    for (const kind of KINDS) expect(new Set(S.externalAddresses[kind]).size).toBe(ADDRESSES_PER_KIND);
    // Scenario D: NextAddr(NESTED_WITNESS_PUBKEY_HASH, change=true) hands out native P2WPKH, not P2SH.
    expect(S.nestedChange).toHaveLength(NESTED_CHANGE_COUNT);
    for (const f of S.nestedChange) expect(f.address).toMatch(/^bcrt1q[0-9a-z]{38}$/);
    expect((await lnd.walletBalance()).confirmedSat).toBe(S.fundedTotalSats);
    expect(await lnd.listUnspent()).toHaveLength(S.funded.length + S.nestedChange.length);
  });

  it("2b. lnd spends from each address type so change lands on the internal branches", async () => {
    const spends = await spendFromEachKind(S.bitcoind!, S.lnd!, {
      externalAddresses: S.externalAddresses,
      funded: S.funded,
      nestedChange: S.nestedChange,
      fundedTotalSats: S.fundedTotalSats,
    });
    S.spentBackSats = spends.spentBackSats;
    S.lndUtxos = spends.lndUtxos;
    S.lndConfirmedSats = spends.lndConfirmedSats;
    S.changeAddresses = spends.changeAddresses;

    expect(S.lndUtxos.reduce((n, u) => n + u.amountSat, 0)).toBe(S.lndConfirmedSats);
    expect(S.lndConfirmedSats).toBeLessThan(S.fundedTotalSats - S.spentBackSats);
    expect(S.lndConfirmedSats).toBeGreaterThan(0);
    // Change on p2wkh (bcrt1q..., 44 chars) and at least two on p2tr (bcrt1p...).
    expect(S.changeAddresses.some((x) => x.startsWith("bcrt1q") && x.length === 44)).toBe(true);
    expect(S.changeAddresses.filter((x) => x.startsWith("bcrt1p")).length).toBeGreaterThanOrEqual(2);
    // The nested change=true coins are still there for recovery.
    const held = new Set(S.lndUtxos.map((u) => u.address));
    for (const f of S.nestedChange) expect(held.has(f.address), `nested change ${f.address} still held`).toBe(true);
    console.log(
      `[e2e] lnd holds ${S.lndUtxos.length} utxos, ${S.lndConfirmedSats} sats; change addresses: ${S.changeAddresses.join(", ")}`,
    );
  });

  it("3. lnd dies hard and its data directory is deleted", async () => {
    const lnd = S.lnd!;
    await lnd.kill();
    lnd.deleteDataDir();
    expect(existsSync(lnd.lnddir)).toBe(false);
  });

  it("4a. chantools derives the addresses lnd used, at the indices lnd used", async () => {
    S.chantools = await genImportScript(S.mnemonic, S.passphrase, CHANTOOLS_WINDOW, NETWORK);
    for (const kind of KINDS) {
      const ext = S.chantools[kind].external;
      expect(ext).toHaveLength(CHANTOOLS_WINDOW);
      expect(ext.slice(0, ADDRESSES_PER_KIND), `${kind} external`).toEqual(S.externalAddresses[kind]);
    }
    const internal84 = S.chantools.p2wkh.internal;
    const internal86 = S.chantools.p2tr.internal;
    for (const addr of S.changeAddresses) {
      const list = addr.startsWith("bcrt1p") ? internal86 : internal84;
      expect(list.indexOf(addr), `change ${addr} on an internal branch`).toBeGreaterThanOrEqual(0);
    }
    // Scenario D: lnd's nested change=true addresses are the wpkh encoding of m/49'/0'/0'/1/i.
    const nested49AsWpkh = S.chantools.np2wkh.encodings.internal.p2wkh;
    expect(S.nestedChange.map((f) => f.address)).toEqual(nested49AsWpkh.slice(0, NESTED_CHANGE_COUNT));
    // And they are NOT the P2SH encoding chantools lists for that branch.
    for (const f of S.nestedChange) expect(S.chantools.np2wkh.internal).not.toContain(f.address);

    // Branch ordering in chantools' output, cross-checked against bitcoind's own deriveaddresses.
    // bitcoind cannot derive hardened steps from a descriptor, so hand it the account-level tpub.
    // Derive that tpub the way lnd does (btcd DeriveNonStandard at coin'/account'): plain BIP32
    // differs for the ~1.9% of seeds with a leading-zero parent key, and lnd's seed is fresh each run.
    const tprv = await showRootKey(S.mnemonic, S.passphrase, NETWORK);
    expect(tprv.startsWith("tprv")).toBe(true);
    const root = HDKey.fromExtendedKey(tprv, { private: 0x04358394, public: 0x043587cf });
    const bd = S.bitcoind!;
    for (const kind of KINDS) {
      const account = accountNode(root, NETWORK, PURPOSE_FOR_KIND[kind]).publicExtendedKey;
      expect(account.startsWith("tpub")).toBe(true);
      for (const change of [0, 1] as const) {
        const inner = `${account}/${change}/*`;
        const desc = kind === "np2wkh" ? `sh(wpkh(${inner}))` : kind === "p2wkh" ? `wpkh(${inner})` : `tr(${inner})`;
        const info = await bd.rpc<{ descriptor: string }>("getdescriptorinfo", [desc]);
        const derived = await bd.rpc<string[]>("deriveaddresses", [info.descriptor, [0, CHANTOOLS_WINDOW - 1]]);
        expect(derived, `${kind}/${change}`).toEqual(change === 0 ? S.chantools[kind].external : S.chantools[kind].internal);
      }
    }
  });

  it("4b. our derivation matches chantools for the first 25 of every wallet and extra branch", async () => {
    const master = await getMaster();
    for (const b of [...WALLET_BRANCHES, ...EXTRA_BRANCHES]) {
      const ours = deriveBranchAddresses(master, NETWORK, b, 0, CHANTOOLS_WINDOW);
      for (const a of ours) {
        expect(a.purpose).toBe(b.purpose);
        expect(a.kind).toBe(b.kind);
        expect(a.change).toBe(b.change);
        expect(a.path).toBe(`m/${b.purpose}'/0'/0'/${b.change}/${a.index}`);
      }
      expect(ours.map((a) => a.address), branchLabel(b)).toEqual(chantoolsBranch(S.chantools!, b));
    }
  });

  it("4c. tier 100 through the Esplora shim recovers exactly lnd's UTXO set, nested change included", async () => {
    const shim = await ensureShim();
    const c = clientFor(shim);
    expect(await c.getTipHeight()).toBe(await S.bitcoind!.blockHeight());
    const master = await getMaster();
    const { result, ms, requests } = await measured(shim, () => scan(deriverFor(master), c, NETWORK, { window: TIER_1 }));
    S.scan100 = result;
    S.tier1 = { ms, requests };
    if (result.utxos.length !== S.lndUtxos.length) {
      const probe = S.nestedChange[0]?.address ?? S.funded[0]!.address;
      const raw = await fetch(`${shim.baseUrl}address/${probe}`).then((r) => r.text());
      console.log(`[e2e] scan mismatch. used=${result.usedAddresses.length} depth=${JSON.stringify(result.depth)}\n  shim ${probe}: ${raw}`);
    }
    expect(outpoints(result.utxos)).toEqual(outpoints(S.lndUtxos));
    expect(result.totalSats).toBe(S.lndConfirmedSats);
    const lndByOutpoint = new Map(S.lndUtxos.map((u) => [`${u.txid}:${u.vout}`, u]));
    for (const u of result.utxos) {
      expect(u.owner.address).toBe(lndByOutpoint.get(`${u.txid}:${u.vout}`)!.address);
      expect(u.status.confirmed).toBe(true);
      expect(coinTypeOfPath(u.owner.path)).toBe(0);
    }
    // Scenario D: the nested change=true coins sit on 49/1/p2wkh at indices 0 and 1.
    for (const [i, f] of S.nestedChange.entries()) {
      const u = result.utxos.find((x) => x.txid === f.txid && x.owner.address === f.address);
      expect(u, `nested change ${f.address} recovered`).toBeDefined();
      expect(branchOf(u!.owner)).toEqual({ purpose: 49, change: 1, kind: "p2wkh" });
      expect(u!.owner.index).toBe(i);
      expect(u!.value).toBe(f.sats);
    }
    const used = new Set(result.usedAddresses.map((a) => a.address));
    for (const f of S.funded) expect(used.has(f.address), `funded ${f.address} is used`).toBe(true);
    for (const ch of S.changeAddresses) expect(used.has(ch), `change ${ch} is used`).toBe(true);
    for (const kind of KINDS) {
      for (const [i, addr] of S.externalAddresses[kind].entries()) {
        if (!FUNDED_INDICES.includes(i)) expect(used.has(addr)).toBe(false);
      }
    }
    // Tier 1 covers the six wallet branches a full gap past the last hit, and leaves the extras alone.
    for (const b of WALLET_BRANCHES) expect(result.depth[branchLabel(b)] ?? 0).toBeGreaterThanOrEqual(TIER_1);
    for (const b of EXTRA_BRANCHES) expect(result.depth[branchLabel(b)]).toBeUndefined();
    // The pacer is not what bounds runtime here: the shim served requests far faster than the client's default rate.
    const achievedPerSecond = requests / (ms / 1000);
    expect(requests).toBeGreaterThanOrEqual(estimateScanCost(NETWORK, { window: TIER_1 }).requests);
    expect(achievedPerSecond).toBeGreaterThan(DEFAULT_RATE_PER_SECOND);
    console.log(`[e2e] tier ${TIER_1}: ${requests} requests in ${(ms / 1000).toFixed(1)} s (${achievedPerSecond.toFixed(0)} req/s)`);
  });

  it("4d. the tier 2500 pass resumed from tier 100 finds nothing new and costs exactly what estimateScanCost predicts", async () => {
    const shim = await ensureShim();
    const c = clientFor(shim);
    const master = await getMaster();
    const predicted = estimateScanCost(NETWORK, { window: TIER_2, resumeFrom: S.scan100! }).requests;
    const { result, ms, requests } = await measured(shim, () =>
      scan(deriverFor(master), c, NETWORK, { window: TIER_2, resumeFrom: S.scan100! }),
    );
    S.scan = result;
    S.tier2 = { ms, requests, predicted };
    expect(outpoints(result.utxos)).toEqual(outpoints(S.scan100!.utxos));
    expect(result.totalSats).toBe(S.lndConfirmedSats);
    expect(result.usedAddresses.map((a) => a.address).sort()).toEqual(S.scan100!.usedAddresses.map((a) => a.address).sort());
    // No new hits, so the only requests are the address lookups the estimate counts.
    expect(requests).toBe(predicted);
    for (const b of [...WALLET_BRANCHES, ...EXTRA_BRANCHES]) expect(result.depth[branchLabel(b)] ?? 0).toBeGreaterThanOrEqual(TIER_2);
    for (const b of WALLET_BRANCHES) expect(result.depthCoin1?.[branchLabel(b)] ?? 0).toBeGreaterThanOrEqual(TIER_2);
  });

  it("4e. an aborted tier 100 scan throws ScanError with a partial result that resumes to the same answer", async () => {
    const shim = await ensureShim();
    const c = clientFor(shim);
    const master = await getMaster();
    const ac = new AbortController();
    let progressEvents = 0;
    const t0 = Date.now();
    let caught: unknown;
    try {
      await scan(deriverFor(master), c, NETWORK, {
        window: TIER_1,
        signal: ac.signal,
        onProgress: () => {
          progressEvents++;
          // Cancel part-way, after a few batches have been absorbed.
          if (progressEvents === 5) ac.abort();
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScanError);
    const err = caught as ScanError;
    expect(err.aborted).toBe(true);
    expect(err.partial.network).toBe(NETWORK);
    const scannedSoFar = Object.values(err.partial.depth).reduce((n, d) => n + (d ?? 0), 0);
    expect(scannedSoFar).toBeGreaterThan(0);
    expect(scannedSoFar).toBeLessThan(TIER_1 * WALLET_BRANCHES.length);
    expect(err.partial.utxos.length).toBeLessThanOrEqual(S.scan100!.utxos.length);

    const resumed = await scan(deriverFor(master), c, NETWORK, { window: TIER_1, resumeFrom: err.partial });
    S.resumeMs = Date.now() - t0;
    expect(outpoints(resumed.utxos)).toEqual(outpoints(S.scan100!.utxos));
    expect(resumed.totalSats).toBe(S.scan100!.totalSats);
    expect(resumed.usedAddresses.map((a) => a.address).sort()).toEqual(S.scan100!.usedAddresses.map((a) => a.address).sort());
    expect(resumed.depth).toEqual(S.scan100!.depth);
  });

  it("5. sweeps everything to a fresh bitcoind address at the shim's fee rate", async () => {
    const bd = S.bitcoind!;
    const shim = await ensureShim();
    const c = clientFor(shim);
    const master = await getMaster();
    const scanResult = S.scan!;

    const feeRate = await fastestFeeRate(c);
    expect(feeRate).toBe(SHIM_FEE_RATE);

    const destination = await bd.newAddress("bech32");
    const plan = planSweep(scanResult.utxos, destination, feeRate, { tipHeight: await c.getTipHeight() });
    expect(plan.inputs).toHaveLength(scanResult.utxos.length);
    expect(plan.feeRateSatPerVb).toBe(SHIM_FEE_RATE);
    expect(plan.outputSats + plan.feeSats).toBe(scanResult.totalSats);

    const signed = signSweep(plan, keyFor(master));
    S.sweep = signed;
    const effective = signed.feeSats / signed.vsize;
    expect(effective).toBeGreaterThanOrEqual(SHIM_FEE_RATE);
    expect(Math.abs(effective - SHIM_FEE_RATE)).toBeLessThan(0.05);
    expect(signed.feeSats).toBe(Math.ceil(signed.vsize * SHIM_FEE_RATE));

    const txid = await c.broadcast(signed.rawTxHex);
    expect(txid).toBe(signed.txid);
    await bd.mine(1);

    const dest = await bd.scanAddresses([destination]);
    expect(dest.totalSats).toBe(scanResult.totalSats - signed.feeSats);
    expect(dest.utxos.map((u) => u.txid)).toEqual([signed.txid]);

    const decoded = await bd.getRawTransaction(signed.txid);
    expect((decoded as { vsize: number }).vsize).toBe(signed.vsize);

    const emptied = await bd.scanAddresses(scanResult.usedAddresses.map((a) => a.address));
    expect(emptied.totalSats).toBe(0);
    const nestedLeft = await bd.scanAddresses(S.nestedChange.map((f) => f.address));
    expect(nestedLeft.totalSats).toBe(0);

    const again = await scan(deriverFor(master), c, NETWORK, { window: TIER_2 });
    expect(again.utxos).toHaveLength(0);
    expect(again.totalSats).toBe(0);
  });

  it("6a. a different fresh seed scans to zero", async () => {
    const shim = await ensureShim();
    const other = (vectors as { name: string; entropy_hex: string; mnemonic: string[]; passphrase: string }[]).find(
      (v) => v.name === "random1-default",
    )!;
    expect(other.entropy_hex).not.toBe(S.entropyHex);
    const seed = await decipherMnemonic(other.mnemonic, other.passphrase);
    const master = masterFromEntropy(seed.entropy);
    // A smaller window keeps this negative check quick; the positive scan above used the default.
    const result = await scan(deriverFor(master), clientFor(shim), NETWORK, { window: TIER_1 });
    expect(result.utxos).toHaveLength(0);
    expect(result.usedAddresses).toHaveLength(0);
    expect(result.totalSats).toBe(0);
  });

  it("6b. a wrong passphrase fails with the typed error before any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(decipherMnemonic(S.mnemonic, "definitely-not-the-passphrase")).rejects.toBeInstanceOf(
        InvalidPassphraseError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
