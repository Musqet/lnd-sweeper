import { describe, expect, it } from "vitest";
import {
  ALL_BRANCHES,
  DEFAULT_EXTRAS_FROM_WINDOW,
  DEFAULT_RECOVERY_WINDOW,
  SCAN_COST,
  SCAN_TIERS,
  SCAN_TIER_RATIONALE,
  ScanError,
  byCoinType,
  coinTypeOf,
  confirmedUtxos,
  estimateScanCost,
  estimateScanSeconds,
  incompleteBranches,
  scan,
  scanDeeper,
  unconfirmedUtxos,
  type CoinType,
  type Deriver,
} from "../../src/chain";
import {
  EXTRA_BRANCHES,
  WALLET_BRANCHES,
  branchKey,
  type Branch,
  type ChainClient,
  type DerivedAddress,
  type Network,
  type ScanProgress,
  type ScanResult,
  type Utxo,
} from "../../src/types";

// The seven branches by name.
const B49E: Branch = { purpose: 49, change: 0, kind: "np2wkh" };
const B49I: Branch = { purpose: 49, change: 1, kind: "p2wkh" }; // lnd encodes m/49' change as NATIVE p2wkh
const B84E: Branch = { purpose: 84, change: 0, kind: "p2wkh" };
const B84I: Branch = { purpose: 84, change: 1, kind: "p2wkh" };
const B86E: Branch = { purpose: 86, change: 0, kind: "p2tr" };
const B86I: Branch = { purpose: 86, change: 1, kind: "p2tr" };
const X49I: Branch = { purpose: 49, change: 1, kind: "np2wkh" }; // belt-and-braces extra

/** Deterministic fake addresses: "<coin>/<purpose>/<change>/<kind>/<index>". */
function addr(coin: CoinType, b: Branch, index: number): string {
  return `${coin}/${branchKey(b)}/${index}`;
}
const deriver: Deriver = (coin, b, index) => ({
  kind: b.kind,
  purpose: b.purpose,
  network: "signet",
  path: `m/${b.purpose}'/${coin}'/0'/${b.change}/${index}`,
  change: b.change,
  index,
  address: addr(coin, b, index),
  publicKey: new Uint8Array(33),
  scriptPubKey: new Uint8Array(22),
});

const confirmed = (txid: string, vout: number, value: number): Utxo => ({
  txid,
  vout,
  value,
  status: { confirmed: true, blockHeight: 100, blockTime: 1_700_000_000 },
});
const unconfirmed = (txid: string, vout: number, value: number): Utxo => ({ txid, vout, value, status: { confirmed: false } });

/**
 * Fake chain: `used` maps address -> utxos (an empty list means "history but
 * spent"). Optional jitter shuffles response timing to exercise ordering.
 */
function fakeClient(used: Record<string, Utxo[]>, opts: { jitter?: boolean } = {}) {
  const statsCalls: string[] = [];
  const utxoCalls: string[] = [];
  const delay = () => (opts.jitter ? new Promise((r) => setTimeout(r, Math.random() * 3)) : Promise.resolve());
  const client: ChainClient = {
    baseUrl: "http://fake/",
    network: "signet",
    getTipHeight: async () => 100,
    getAddressStats: async (a) => {
      statsCalls.push(a);
      await delay();
      const hit = used[a];
      return hit
        ? { chainTxCount: 1, mempoolTxCount: hit.some((u) => !u.status.confirmed) ? 1 : 0, fundedSats: 0, spentSats: 0 }
        : { chainTxCount: 0, mempoolTxCount: 0, fundedSats: 0, spentSats: 0 };
    },
    getAddressUtxos: async (a) => {
      utxoCalls.push(a);
      await delay();
      return used[a] ?? [];
    },
    getAddressTxs: async () => [],
    getFeeEstimates: async () => ({ "1": 1 }),
    broadcast: async () => "00".repeat(32),
  };
  return { client, statsCalls, utxoCalls };
}

const W = 10;
const indicesScanned = (calls: string[], coin: CoinType, b: Branch) =>
  calls
    .filter((a) => a.startsWith(`${coin}/${branchKey(b)}/`))
    .map((a) => Number(a.split("/")[4]))
    .sort((x, y) => x - y);
const depthOf = (r: { depth: Partial<Record<string, number>> }, b: Branch) => r.depth[branchKey(b)];
const branchOfCall = (a: string) => a.split("/").slice(1, 4).join("/");

describe("branch table and tiers", () => {
  it("scans lnd's six real branches, with m/49' change as native p2wkh, and one extra", () => {
    expect(WALLET_BRANCHES).toHaveLength(6);
    expect(WALLET_BRANCHES[1]).toEqual(B49I);
    expect(EXTRA_BRANCHES).toEqual([X49I]);
    expect(ALL_BRANCHES).toEqual([B49E, B49I, B84E, B84I, B86E, B86I, X49I]);
  });
  it("offers two tiers: a generous gap limit of 100, then lnd's 2500", () => {
    expect(SCAN_TIERS).toEqual([100, 2500]);
    expect(SCAN_TIERS[1]).toBe(DEFAULT_RECOVERY_WINDOW);
    expect(DEFAULT_EXTRAS_FROM_WINDOW).toBe(2500);
    for (const t of SCAN_TIERS) expect(SCAN_TIER_RATIONALE[t].length).toBeGreaterThan(20);
  });
});

describe("scan: gap semantics (btcwallet recovery window)", () => {
  it("empty wallet on mainnet: exactly one window per real branch, no extras below the extras threshold, coin 0 only", async () => {
    const { client, statsCalls } = fakeClient({});
    const r = await scan(deriver, client, "mainnet", { window: W, batchSize: 3 });
    expect(r.utxos).toEqual([]);
    expect(r.totalSats).toBe(0);
    expect(r.usedAddresses).toEqual([]);
    for (const b of WALLET_BRANCHES) expect(depthOf(r, b)).toBe(W);
    expect(depthOf(r, X49I)).toBeUndefined();
    expect(Object.keys(r.depth)).toHaveLength(6);
    expect(r.depthCoin1).toBeUndefined();
    expect(statsCalls).toHaveLength(W * 6);
    expect(statsCalls.every((a) => a.startsWith("0/"))).toBe(true);
  });

  it("extras join once window >= extrasFromWindow; skipExtras always excludes them", async () => {
    const { client, statsCalls } = fakeClient({});
    const r = await scan(deriver, client, "mainnet", { window: W, extrasFromWindow: W });
    expect(statsCalls).toHaveLength(W * 7);
    expect(depthOf(r, X49I)).toBe(W);
    const { client: c2, statsCalls: s2 } = fakeClient({});
    await scan(deriver, c2, "mainnet", { window: W, extrasFromWindow: W, skipExtras: true });
    expect(s2).toHaveLength(W * 6);
  });

  it("off mainnet adds a secondary coin type 1 pass, after the coin 0 pass", async () => {
    const { client, statsCalls } = fakeClient({});
    const r = await scan(deriver, client, "signet", { window: W });
    expect(statsCalls).toHaveLength(W * 12);
    expect(statsCalls.slice(0, W * 6).every((a) => a.startsWith("0/"))).toBe(true);
    expect(statsCalls.slice(W * 6).every((a) => a.startsWith("1/"))).toBe(true);
    for (const b of WALLET_BRANCHES) expect(r.depthCoin1![branchKey(b)]).toBe(W);
  });

  it("used address at index 0 only: scans window more addresses after it", async () => {
    const { client, statsCalls } = fakeClient({ [addr(0, B84E, 0)]: [confirmed("aa".repeat(32), 0, 1000)] });
    const r = await scan(deriver, client, "mainnet", { window: W, batchSize: 4 });
    expect(depthOf(r, B84E)).toBe(1 + W);
    expect(indicesScanned(statsCalls, 0, B84E)).toEqual(Array.from({ length: 1 + W }, (_, i) => i));
    expect(depthOf(r, B84I)).toBe(W);
    expect(r.totalSats).toBe(1000);
  });

  it("gap of exactly window - 1 unused addresses is bridged", async () => {
    const { client } = fakeClient({
      [addr(0, B84E, 0)]: [confirmed("aa".repeat(32), 0, 1)],
      [addr(0, B84E, W)]: [confirmed("bb".repeat(32), 0, 2)],
    });
    const r = await scan(deriver, client, "mainnet", { window: W, batchSize: 3 });
    expect(r.usedAddresses.map((a) => a.index)).toEqual([0, W]);
    expect(depthOf(r, B84E)).toBe(W + 1 + W);
    expect(r.totalSats).toBe(3);
  });

  it("gap of exactly window unused addresses is NOT bridged (matches lnd)", async () => {
    const { client, statsCalls } = fakeClient({
      [addr(0, B84E, 0)]: [confirmed("aa".repeat(32), 0, 1)],
      [addr(0, B84E, W + 1)]: [confirmed("bb".repeat(32), 0, 2)],
    });
    const r = await scan(deriver, client, "mainnet", { window: W, batchSize: 3 });
    expect(r.usedAddresses.map((a) => a.index)).toEqual([0]);
    expect(depthOf(r, B84E)).toBe(1 + W);
    expect(indicesScanned(statsCalls, 0, B84E)).not.toContain(W + 1);
  });

  it("used address at index 2499 with the 2500 window is found and extends to 5000", async () => {
    const { client, statsCalls } = fakeClient({ [addr(0, B86I, 2499)]: [confirmed("cc".repeat(32), 3, 42)] });
    const r = await scan(deriver, client, "mainnet", { branches: [B86I] });
    expect(r.usedAddresses.map((a) => a.index)).toEqual([2499]);
    expect(depthOf(r, B86I)).toBe(2 * DEFAULT_RECOVERY_WINDOW);
    expect(statsCalls).toHaveLength(2 * DEFAULT_RECOVERY_WINDOW);
    expect(r.utxos[0]).toMatchObject({ txid: "cc".repeat(32), vout: 3, value: 42, owner: { kind: "p2tr", purpose: 86, change: 1, index: 2499 } });
  });

  it("funds only on the m/49' change branch as NATIVE p2wkh (the real lnd encoding)", async () => {
    const { client } = fakeClient({
      [addr(0, B49I, 4)]: [confirmed("dd".repeat(32), 0, 1_450_000)],
      [addr(0, B49I, 7)]: [], // history, nothing left
    });
    const r = await scan(deriver, client, "mainnet", { window: W, batchSize: 5 });
    expect(depthOf(r, B49E)).toBe(W);
    expect(depthOf(r, B49I)).toBe(7 + 1 + W);
    expect(r.usedAddresses.map((a) => [a.purpose, a.change, a.kind, a.index])).toEqual([
      [49, 1, "p2wkh", 4],
      [49, 1, "p2wkh", 7],
    ]);
    expect(r.utxos[0]!.owner.kind).toBe("p2wkh");
    expect(r.utxos[0]!.owner.path).toBe("m/49'/0'/0'/1/4");
    expect(r.totalSats).toBe(1_450_000);
  });

  it("funds only on the m/49' change branch as NESTED p2wkh (extra) are found from the extras tier on", async () => {
    const used = { [addr(0, X49I, 3)]: [confirmed("ee".repeat(32), 0, 777)] };
    const { client } = fakeClient(used);
    expect((await scan(deriver, client, "mainnet", { window: W })).totalSats).toBe(0); // tier below threshold
    const { client: c2 } = fakeClient(used);
    const r = await scan(deriver, c2, "mainnet", { window: W, extrasFromWindow: W });
    expect(r.totalSats).toBe(777);
    expect(depthOf(r, X49I)).toBe(3 + 1 + W);
    expect(depthOf(r, B49I)).toBe(W);
    expect(r.utxos[0]!.owner).toMatchObject({ purpose: 49, change: 1, kind: "np2wkh", index: 3 });
  });

  it("funds only on p2tr", async () => {
    const { client } = fakeClient({ [addr(0, B86E, 2)]: [confirmed("ee".repeat(32), 1, 7), confirmed("ee".repeat(32), 0, 8)] });
    const r = await scan(deriver, client, "mainnet", { window: W });
    expect(depthOf(r, B49E)).toBe(W);
    expect(depthOf(r, B86E)).toBe(2 + 1 + W);
    expect(r.utxos.map((u) => u.vout)).toEqual([0, 1]);
    expect(r.totalSats).toBe(15);
  });

  it("includes unconfirmed utxos but flags them", async () => {
    const { client } = fakeClient({ [addr(0, B84E, 1)]: [confirmed("aa".repeat(32), 0, 100), unconfirmed("bb".repeat(32), 0, 50)] });
    const r = await scan(deriver, client, "mainnet", { window: W });
    expect(r.totalSats).toBe(150);
    expect(confirmedUtxos(r).map((u) => u.value)).toEqual([100]);
    expect(unconfirmedUtxos(r).map((u) => u.value)).toEqual([50]);
  });

  it("clamps the final batch to the horizon", async () => {
    const { client, statsCalls } = fakeClient({});
    await scan(deriver, client, "mainnet", { window: W, batchSize: 50, branches: [B84E] });
    expect(statsCalls).toHaveLength(W);
  });
});

describe("scan: breadth first across branches", () => {
  it("interleaves one batch per branch per round", async () => {
    const { client, statsCalls } = fakeClient({});
    await scan(deriver, client, "mainnet", { window: W, batchSize: 5 });
    const rounds = [] as string[][];
    for (let i = 0; i < statsCalls.length; i += 5) rounds.push(statsCalls.slice(i, i + 5));
    // Round 1: indices 0..4 on each of the six branches in order; round 2: indices 5..9.
    expect(rounds.slice(0, 6).map((r) => branchOfCall(r[0]!))).toEqual(WALLET_BRANCHES.map(branchKey));
    expect(rounds.slice(6, 12).map((r) => branchOfCall(r[0]!))).toEqual(WALLET_BRANCHES.map(branchKey));
    expect(rounds[0]!.map((a) => Number(a.split("/")[4]))).toEqual([0, 1, 2, 3, 4]);
    expect(rounds[6]!.map((a) => Number(a.split("/")[4]))).toEqual([5, 6, 7, 8, 9]);
  });

  it("a branch that extends keeps getting rounds after the others finish; all branches report early", async () => {
    const { client, statsCalls } = fakeClient({ [addr(0, B86I, 8)]: [confirmed("aa".repeat(32), 0, 1)] });
    const events: ScanProgress[] = [];
    await scan(deriver, client, "mainnet", { window: W, batchSize: 5, onProgress: (p) => events.push(p) });
    // First six progress events are one per branch (every branch shows something after round 1).
    expect(events.slice(0, 6).map((e) => branchKey(e.branch))).toEqual(WALLET_BRANCHES.map(branchKey));
    // Only 86/1 continues past 10: 8+1+10 = 19 -> indices 10..18 in rounds of 5.
    const tail = statsCalls.slice(6 * W);
    expect(tail.every((a) => branchOfCall(a) === branchKey(B86I))).toBe(true);
    expect(tail).toHaveLength(9);
  });

  it("returns deterministic order regardless of response timing", async () => {
    const used: Record<string, Utxo[]> = {
      [addr(0, B86I, 3)]: [confirmed("99".repeat(32), 0, 1)],
      [addr(0, B49E, 5)]: [confirmed("11".repeat(32), 1, 2), confirmed("11".repeat(32), 0, 3)],
      [addr(0, B84E, 1)]: [confirmed("55".repeat(32), 0, 4)],
      [addr(0, B49I, 0)]: [confirmed("22".repeat(32), 0, 5)],
      [addr(0, X49I, 0)]: [confirmed("33".repeat(32), 0, 7)],
      [addr(1, B84E, 0)]: [confirmed("00".repeat(32), 0, 6)],
    };
    const expectedOwners = [addr(0, B49E, 5), addr(0, B49E, 5), addr(0, B49I, 0), addr(0, B84E, 1), addr(0, B86I, 3), addr(0, X49I, 0), addr(1, B84E, 0)];
    for (let run = 0; run < 3; run++) {
      const { client } = fakeClient(used, { jitter: true });
      const r = await scan(deriver, client, "signet", { window: W, batchSize: 4, extrasFromWindow: W });
      expect(r.utxos.map((u) => u.owner.address)).toEqual(expectedOwners);
      expect(r.utxos.slice(0, 2).map((u) => u.vout)).toEqual([0, 1]);
      expect(r.totalSats).toBe(28);
    }
  });
});

describe("scan: progress and coin types", () => {
  it("reports progress after every batch with the branch, coin type and running totals", async () => {
    const { client } = fakeClient({ [addr(0, B84E, 2)]: [confirmed("aa".repeat(32), 0, 10)] });
    const events: ScanProgress[] = [];
    const r = await scan(deriver, client, "mainnet", { window: W, batchSize: 4, branches: [B84E], onProgress: (p) => events.push(p) });
    expect(events.map((e) => e.scanned)).toEqual([4, 8, 12, 13]);
    expect(events.every((e) => e.coinType === 0 && e.window === W)).toBe(true);
    expect(events.every((e) => e.branch.purpose === 84 && e.branch.change === 0 && e.branch.kind === "p2wkh")).toBe(true);
    expect(events.map((e) => e.lastUsedIndex)).toEqual([2, 2, 2, 2]);
    expect(events[3]!.satsFound).toBe(10);
    expect(events[3]!.scanned).toBe(depthOf(r, B84E));
  });

  it("finds funds that only exist on coin type 1 off mainnet, and labels them", async () => {
    const { client } = fakeClient({ [addr(1, B84E, 3)]: [confirmed("ab".repeat(32), 0, 777)] });
    const r = await scan(deriver, client, "regtest", { window: W });
    expect(r.totalSats).toBe(777);
    expect(coinTypeOf(r.utxos[0]!.owner)).toBe(1);
    expect(r.depthCoin1![branchKey(B84E)]).toBe(3 + 1 + W);
    expect(byCoinType(r)[1].totalSats).toBe(777);
    expect(byCoinType(r)[0].utxos).toEqual([]);
  });

  it("never looks at coin type 1 on mainnet; coinTypes can restrict passes", async () => {
    const { client, statsCalls } = fakeClient({ [addr(1, B84E, 0)]: [confirmed("ab".repeat(32), 0, 777)] });
    const r = await scan(deriver, client, "mainnet", { window: W });
    expect(r.totalSats).toBe(0);
    expect(statsCalls.some((a) => a.startsWith("1/"))).toBe(false);
    const { client: c2, statsCalls: s2 } = fakeClient({});
    const r2 = await scan(deriver, c2, "signet", { window: W, coinTypes: [0] });
    expect(s2.every((a) => a.startsWith("0/"))).toBe(true);
    expect(r2.depthCoin1).toBeUndefined();
  });

  it("validates options", async () => {
    const { client } = fakeClient({});
    await expect(scan(deriver, client, "mainnet", { window: 0 })).rejects.toThrow(/window/);
    await expect(scan(deriver, client, "mainnet", { batchSize: 1.5 })).rejects.toThrow(/batchSize/);
    const first = await scan(deriver, client, "signet", { window: 2 });
    await expect(scan(deriver, client, "mainnet" as Network, { resumeFrom: first })).rejects.toThrow(/different network/);
  });
});

describe("tiers: resumeFrom with a larger window", () => {
  it("empty wallet, real tiers on mainnet: 600 then 16,900 requests, every address looked up exactly once", async () => {
    const { client, statsCalls } = fakeClient({});
    const t1 = await scan(deriver, client, "mainnet", { window: 100 });
    expect(statsCalls).toHaveLength(600);
    for (const b of WALLET_BRANCHES) expect(depthOf(t1, b)).toBe(100);
    expect(depthOf(t1, X49I)).toBeUndefined();
    const t2 = await scan(deriver, client, "mainnet", { window: 2500, resumeFrom: t1 });
    expect(statsCalls).toHaveLength(17_500);
    expect(new Set(statsCalls).size).toBe(17_500);
    for (const b of ALL_BRANCHES) expect(depthOf(t2, b)).toBe(2500);
  });

  it("a hit found in a later tier extends only its own branch to lastUsed + 1 + newWindow", async () => {
    const { client, statsCalls } = fakeClient({
      [addr(0, B84E, 3)]: [confirmed("aa".repeat(32), 0, 1)], // found in tier 1 (window 10)
      [addr(0, B86I, 25)]: [confirmed("bb".repeat(32), 0, 2)], // beyond tier 1, found in tier 2 (window 30)
    });
    const t1 = await scan(deriver, client, "mainnet", { window: 10, batchSize: 4 });
    expect(t1.totalSats).toBe(1);
    expect(depthOf(t1, B84E)).toBe(3 + 1 + 10);
    expect(depthOf(t1, B86I)).toBe(10);
    statsCalls.length = 0;
    const t2 = await scanDeeper(deriver, client, t1, { window: 30, batchSize: 4 });
    expect(t2.totalSats).toBe(3);
    expect(depthOf(t2, B84E)).toBe(3 + 1 + 30); // hit carried over: horizon recomputed for the new window
    expect(depthOf(t2, B86I)).toBe(25 + 1 + 30); // new hit extends this branch only
    for (const b of [B49E, B49I, B84I, B86E]) expect(depthOf(t2, b)).toBe(30);
    // No address looked up twice across tiers.
    expect(indicesScanned(statsCalls, 0, B84E)[0]).toBe(14);
    expect(indicesScanned(statsCalls, 0, B86I)[0]).toBe(10);
    expect(indicesScanned(statsCalls, 0, B49E)[0]).toBe(10);
    expect(t2.usedAddresses.map((a) => a.address)).toEqual([addr(0, B84E, 3), addr(0, B86I, 25)]);
    expect(t2.utxos.filter((u) => u.txid === "aa".repeat(32))).toHaveLength(1);
  });

  it("tier 2 brings extras in from index 0 while real branches continue from their depth", async () => {
    const { client, statsCalls } = fakeClient({ [addr(0, X49I, 12)]: [confirmed("cc".repeat(32), 0, 9)] });
    const t1 = await scan(deriver, client, "mainnet", { window: 10, extrasFromWindow: 20 });
    expect(t1.totalSats).toBe(0);
    statsCalls.length = 0;
    const t2 = await scan(deriver, client, "mainnet", { window: 20, extrasFromWindow: 20, resumeFrom: t1 });
    expect(t2.totalSats).toBe(9);
    expect(indicesScanned(statsCalls, 0, X49I)[0]).toBe(0);
    expect(indicesScanned(statsCalls, 0, B49E)[0]).toBe(10);
    expect(depthOf(t2, X49I)).toBe(12 + 1 + 20);
  });

  it("the same window on a complete result is a no-op", async () => {
    const { client, statsCalls } = fakeClient({ [addr(0, B84E, 1)]: [confirmed("aa".repeat(32), 0, 1)] });
    const first = await scan(deriver, client, "signet", { window: W });
    statsCalls.length = 0;
    const again = await scan(deriver, client, "signet", { window: W, resumeFrom: first });
    expect(statsCalls).toEqual([]);
    expect(again).toEqual(first);
  });

  it("off mainnet, tiers apply to both coin passes", async () => {
    const { client, statsCalls } = fakeClient({ [addr(1, B86I, 12)]: [confirmed("cc".repeat(32), 0, 300)] });
    const t1 = await scan(deriver, client, "signet", { window: W, batchSize: 4 });
    expect(t1.totalSats).toBe(0);
    statsCalls.length = 0;
    const t2 = await scanDeeper(deriver, client, t1, { window: 2 * W, batchSize: 4 });
    expect(t2.totalSats).toBe(300);
    expect(t2.depthCoin1![branchKey(B86I)]).toBe(12 + 1 + 2 * W);
    expect(depthOf(t2, B86I)).toBe(2 * W);
    expect(indicesScanned(statsCalls, 1, B86I)[0]).toBe(W);
  });
});

describe("scan: abort and partial results", () => {
  /** Client that fails a given address lookup once (or always). */
  function flakyClient(used: Record<string, Utxo[]>, failOn: { address: string; times: number; where?: "stats" | "utxo" }) {
    const base = fakeClient(used);
    let failures = 0;
    const client: ChainClient = {
      ...base.client,
      getAddressStats: async (a) => {
        if (failOn.where !== "utxo" && a === failOn.address && failures < failOn.times) {
          failures++;
          throw new Error(`503 from ${a}`);
        }
        return base.client.getAddressStats(a);
      },
      getAddressUtxos: async (a) => {
        if (failOn.where === "utxo" && a === failOn.address && failures < failOn.times) {
          failures++;
          throw new Error(`utxo 503 from ${a}`);
        }
        return base.client.getAddressUtxos(a);
      },
    };
    return { client, statsCalls: base.statsCalls, utxoCalls: base.utxoCalls };
  }
  const bk = (list: { coinType: CoinType; branch: Branch }[]) => list.map((b) => `${b.coinType}/${branchKey(b.branch)}`);

  it("stops between batches when the signal fires, throwing ScanError with the partial", async () => {
    const controller = new AbortController();
    const { client, statsCalls } = fakeClient({});
    const p = scan(deriver, client, "mainnet", {
      window: W,
      batchSize: 2,
      onProgress: (e) => {
        if (branchKey(e.branch) === branchKey(B86I) && e.scanned === 2) controller.abort(); // end of round 1
      },
      signal: controller.signal,
    });
    const err = (await p.catch((e: unknown) => e)) as ScanError;
    expect(err).toBeInstanceOf(ScanError);
    expect(err.aborted).toBe(true);
    expect((err.cause as Error).name).toBe("AbortError");
    for (const b of WALLET_BRANCHES) expect(depthOf(err.partial, b)).toBe(2);
    expect(statsCalls).toHaveLength(12);
  });

  it("throws ScanError carrying everything found so far and depth at the last completed batch of every branch", async () => {
    const used = {
      [addr(0, B49E, 2)]: [confirmed("aa".repeat(32), 0, 100)],
      [addr(0, B84I, 6)]: [confirmed("bb".repeat(32), 0, 200)], // round 2 on 84/1; failure hits 84/0 in round 2 first
    };
    const { client } = flakyClient(used, { address: addr(0, B84E, 5), times: Infinity });
    const err = (await scan(deriver, client, "mainnet", { window: W, batchSize: 4 }).catch((e: unknown) => e)) as ScanError;
    expect(err).toBeInstanceOf(ScanError);
    expect(err.aborted).toBe(false);
    expect(err.message).toMatch(/Scan failed: 503/);
    const p = err.partial;
    expect(p.totalSats).toBe(100);
    expect(p.usedAddresses.map((a) => a.address)).toEqual([addr(0, B49E, 2)]);
    // Round 1 done everywhere (depth 4); round 2 done on 49/0 and 49/1 (depth 8); 84/0 failed at 4; the rest never got round 2.
    expect(depthOf(p, B49E)).toBe(8);
    expect(depthOf(p, B49I)).toBe(8);
    expect(depthOf(p, B84E)).toBe(4);
    expect(depthOf(p, B84I)).toBe(4);
    expect(depthOf(p, B86E)).toBe(4);
    expect(depthOf(p, B86I)).toBe(4);
    expect(bk(incompleteBranches(p, W))).toEqual(WALLET_BRANCHES.map((b) => `0/${branchKey(b)}`));
  });

  it("resuming from the partial finishes exactly what is left and matches an uninterrupted scan", async () => {
    const used = {
      [addr(0, B49E, 2)]: [confirmed("aa".repeat(32), 0, 100)],
      [addr(0, B84I, 6)]: [confirmed("bb".repeat(32), 0, 200)],
    };
    const { client, statsCalls } = flakyClient(used, { address: addr(0, B84E, 5), times: 1 });
    const err = (await scan(deriver, client, "mainnet", { window: W, batchSize: 4 }).catch((e: unknown) => e)) as ScanError;
    statsCalls.length = 0;
    const done = await scan(deriver, client, "mainnet", { window: W, batchSize: 4, resumeFrom: err.partial });
    const { client: clean } = fakeClient(used);
    const reference = await scan(deriver, clean, "mainnet", { window: W, batchSize: 4 });
    expect(done.depth).toEqual(reference.depth);
    expect(done.utxos).toEqual(reference.utxos);
    expect(done.totalSats).toBe(300);
    expect(indicesScanned(statsCalls, 0, B49E)[0]).toBe(8);
    expect(indicesScanned(statsCalls, 0, B84E)[0]).toBe(4);
    expect(new Set(statsCalls).size).toBe(statsCalls.length); // nothing twice within the resume
    expect(incompleteBranches(done, W)).toEqual([]);
  });

  it("a failed /utxo lookup does not commit the batch, so its used address is rediscovered on resume", async () => {
    const used = { [addr(0, B86E, 1)]: [confirmed("cc".repeat(32), 0, 5)] };
    const { client, statsCalls } = flakyClient(used, { address: addr(0, B86E, 1), times: 1, where: "utxo" });
    const err = (await scan(deriver, client, "mainnet", { window: W, batchSize: 4, branches: [B86E] }).catch((e: unknown) => e)) as ScanError;
    expect(err.partial.usedAddresses).toEqual([]);
    expect(depthOf(err.partial, B86E)).toBe(0);
    statsCalls.length = 0;
    const done = await scan(deriver, client, "mainnet", { window: W, batchSize: 4, branches: [B86E], resumeFrom: err.partial });
    expect(done.totalSats).toBe(5);
    expect(indicesScanned(statsCalls, 0, B86E)[0]).toBe(0);
  });

  it("accepts an async deriver", async () => {
    const asyncDeriver: Deriver = async (...args) => deriver(...args) as DerivedAddress;
    const { client } = fakeClient({ [addr(0, B84E, 0)]: [confirmed("aa".repeat(32), 0, 1)] });
    expect((await scan(asyncDeriver, client, "mainnet", { window: 3 })).totalSats).toBe(1);
  });
});

describe("scan cost", () => {
  it("per tier, empty wallet: mainnet 600 then 16,900 (17,500 total); off mainnet double", () => {
    expect(SCAN_COST.mainnet.map((t) => [t.window, t.incremental.requests, t.cumulative.requests])).toEqual([
      [100, 600, 600],
      [2500, 16_900, 17_500],
    ]);
    expect(SCAN_COST.mainnet[0]!.incremental.progressEvents).toBe(12); // 6 branches x 2 batches of 50
    expect(SCAN_COST.offMainnet.map((t) => [t.window, t.incremental.requests, t.cumulative.requests])).toEqual([
      [100, 1_200, 1_200],
      [2500, 33_800, 35_000],
    ]);
  });

  it("estimateScanCost is incremental from a previous result and honours hits", async () => {
    expect(estimateScanCost("mainnet", { window: 100 })).toEqual({ requests: 600, progressEvents: 12 });
    expect(estimateScanCost("mainnet", { window: 100, branches: [B84E] })).toEqual({ requests: 100, progressEvents: 2 });
    const { client } = fakeClient({ [addr(0, B84E, 3)]: [confirmed("aa".repeat(32), 0, 1)] });
    const t1 = await scan(deriver, client, "mainnet", { window: 10, batchSize: 4 });
    // Next tier 30: five branches 10 -> 30 (20 each) + 84/0 from 14 -> 34 (20) = 120.
    expect(estimateScanCost("mainnet", { window: 30, batchSize: 4, resumeFrom: t1 })).toEqual({ requests: 120, progressEvents: 30 });
    expect(estimateScanCost("mainnet", { window: 10, resumeFrom: t1 })).toEqual({ requests: 0, progressEvents: 0 });
  });

  it("estimateScanSeconds uses the client's default rate", () => {
    expect(estimateScanSeconds(600)).toBe(75);
    expect(estimateScanSeconds(16_900)).toBe(2113);
    expect(estimateScanSeconds(1000, 4)).toBe(250);
  });

  it("matches what an empty scan actually does", async () => {
    const { client, statsCalls } = fakeClient({});
    let events = 0;
    const opts = { window: 10, batchSize: 4 };
    await scan(deriver, client, "signet", { ...opts, onProgress: () => events++ });
    expect(statsCalls).toHaveLength(estimateScanCost("signet", opts).requests);
    expect(events).toBe(estimateScanCost("signet", opts).progressEvents);
  });

  it("a ScanResult round-trips as resumeFrom for cost estimates", () => {
    const r: ScanResult = { network: "mainnet", utxos: [], usedAddresses: [], totalSats: 0, depth: { "84/0/p2wkh": 100 } };
    expect(estimateScanCost("mainnet", { window: 100, resumeFrom: r }).requests).toBe(500);
  });
});
