/**
 * Seed-specific recovery scenarios, folded in from the e2e critic. Each seed
 * was chosen (via lnd's aezeed package, see harness/critic-seeds.json) so that
 * a hardened node on the wallet path has a SHORT private key (leading zero
 * bytes), where btcd's DeriveNonStandard and a naive BIP32 diverge. One
 * scenario adds an aezeed passphrase, one funds a high index (299) so the
 * default 2500 window has to reach it. In every scenario lnd is initialised
 * from the words, funded on all three kinds plus WalletKit NextAddr change=true
 * addresses, killed and wiped; recovery sees only the words (+ passphrase) and
 * the Esplora shim.
 *
 * Each scenario gets its own bitcoind, shim and lnd: two scenarios reuse a seed
 * (A2/C and A3/B) and must not see each other's chain history.
 * Output never includes seed words; the entropy hex identifies a seed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import type { HDKey } from "@scure/bip32";
import type { AddressKind, Branch, ScanResult, SignedSweep } from "../../src/types";
import { EXTRA_BRANCHES, WALLET_BRANCHES } from "../../src/types";
import { decipherMnemonic, InvalidPassphraseError } from "../../src/aezeed";
import { deriveBranchAddresses, masterFromEntropy } from "../../src/keys";
import { SCAN_TIERS, estimateScanCost, scan } from "../../src/chain";
import { planSweep, signSweep } from "../../src/tx";
import { start as startShim, type Shim } from "./esplora-shim";
import { startBitcoind, type Bitcoind } from "./harness/bitcoind";
import { startLnd, type Lnd, type LndUtxo } from "./harness/lnd";
import { genImportScript, type ChantoolsAddresses } from "./harness/chantools";
import { SHIM_FEE_RATE } from "./harness/up";
import {
  NETWORK,
  branchLabel,
  branchOf,
  chantoolsBranch,
  clientFor,
  deriverFor,
  fastestFeeRate,
  hex,
  keyFor,
  measured,
  outpoints,
} from "./harness/recovery";
import { freePort, waitFor } from "./harness/util";
import seeds from "./harness/critic-seeds.json";

interface SeedRec {
  name: string;
  entropy_hex: string;
  passphrase: string;
  birthday_days: number;
  mnemonic: string[];
}
const SEEDS = seeds as SeedRec[];
const seed = (name: string): SeedRec => {
  const s = SEEDS.find((x) => x.name === name);
  if (!s) throw new Error(`no seed ${name} in critic-seeds.json`);
  return s;
};

type Mode = "affected" | "passphrase" | "highindex";
interface Scenario {
  id: string;
  mode: Mode;
  seed: SeedRec;
  /** Kind whose purpose path holds the short key. */
  affectedKind: AddressKind;
  shortKeys: string;
}

const SCENARIOS: Scenario[] = [
  { id: "A1 m49'/0' short1", mode: "affected", seed: seed("m49-0-short1"), affectedKind: "np2wkh", shortKeys: "m/49'/0' (1 zero byte)" },
  { id: "A2 m84' short2", mode: "affected", seed: seed("m84-short2"), affectedKind: "p2wkh", shortKeys: "m/84' (2 zero bytes)" },
  { id: "A3 m86'/0' short1", mode: "affected", seed: seed("m86-0-short1"), affectedKind: "p2tr", shortKeys: "m/86'/0' (1 zero byte)" },
  { id: "A4 m84' and m84'/0' short1", mode: "affected", seed: seed("m84-and-m84-0-short1"), affectedKind: "p2wkh", shortKeys: "m/84' and m/84'/0' (1 each)" },
  { id: "A5 m49' short1", mode: "affected", seed: seed("m49-short1"), affectedKind: "np2wkh", shortKeys: "m/49' (1 zero byte)" },
  { id: "B passphrase, m86'/0' short1", mode: "passphrase", seed: seed("m86-0-short1-pass"), affectedKind: "p2tr", shortKeys: "m/86'/0' (1 zero byte)" },
  { id: "C high index 299 on p2wkh, m84' short2", mode: "highindex", seed: seed("m84-short2"), affectedKind: "p2wkh", shortKeys: "m/84' (2 zero bytes)" },
];

const KINDS: readonly AddressKind[] = ["np2wkh", "p2wkh", "p2tr"];
const ALL_BRANCHES: readonly Branch[] = [...WALLET_BRANCHES, ...EXTRA_BRANCHES];
const HIGH_INDEX = 299;
const HIGH_INDEX_SATS = 2_500_000;
const [TIER_1, TIER_2] = SCAN_TIERS as readonly [100, 2500];

interface Row {
  id: string;
  entropy: string;
  lndUtxos: number;
  lndSats: number;
  recoveredUtxos: number;
  recoveredSats: number;
  /** Sats found by the tier-100 pass alone. */
  tier1Sats: number;
  tier1Ms: number;
  tier1Requests: number;
  tier2Ms: number;
  tier2Requests: number;
  tier2Predicted: number;
  sweptSats: number;
  feeSats: number;
  vsize: number;
  txid: string;
}
const ROWS: Row[] = [];

const CLEANUP_ERRORS: string[] = [];
async function tryDo(what: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    CLEANUP_ERRORS.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

describe("seed-specific recovery scenarios", () => {
  afterAll(() => {
    const errors = CLEANUP_ERRORS;
    const header = [
      "scenario",
      "entropy",
      "lnd utxos",
      "lnd sats",
      "tier100 sats",
      "t100 s/req",
      "tier2500 sats",
      "t2500 s/req (pred)",
      "recovered",
      "swept",
      "fee",
      "vsize",
      "sat/vB",
    ];
    const lines = ROWS.map((r) => [
      r.id,
      r.entropy,
      String(r.lndUtxos),
      String(r.lndSats),
      String(r.tier1Sats),
      `${(r.tier1Ms / 1000).toFixed(1)}/${r.tier1Requests}`,
      String(r.recoveredSats),
      `${(r.tier2Ms / 1000).toFixed(1)}/${r.tier2Requests} (${r.tier2Predicted})`,
      String(r.recoveredUtxos),
      String(r.sweptSats),
      String(r.feeSats),
      String(r.vsize),
      r.vsize ? (r.feeSats / r.vsize).toFixed(3) : "-",
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
    const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
    console.log("\n[e2e seeds] summary\n  " + [fmt(header), ...lines.map(fmt)].join("\n  ") + "\n");
    if (errors.length) console.error("[e2e seeds] cleanup problems:\n  " + errors.join("\n  "));
  });

  for (const sc of SCENARIOS) {
    describe(sc.id, () => {
      let bd: Bitcoind | undefined;
      let shim: Shim | undefined;
      let lnd: Lnd | undefined;
      let master: HDKey | undefined;
      const external: Record<AddressKind, string[]> = { np2wkh: [], p2wkh: [], p2tr: [] };
      /** WalletKit NextAddr change=true addresses per kind requested, in order. */
      const nextChange: Record<AddressKind, string[]> = { np2wkh: [], p2wkh: [], p2tr: [] };
      const fundedAddrs = new Set<string>();
      let lndUtxos: LndUtxo[] = [];
      let lndSats = 0;
      let chantools: ChantoolsAddresses | undefined;
      let result: ScanResult | undefined;
      let sweep: SignedSweep | undefined;
      const row: Row = {
        id: sc.id,
        entropy: sc.seed.entropy_hex,
        lndUtxos: 0,
        lndSats: 0,
        recoveredUtxos: 0,
        recoveredSats: 0,
        tier1Sats: 0,
        tier1Ms: 0,
        tier1Requests: 0,
        tier2Ms: 0,
        tier2Requests: 0,
        tier2Predicted: 0,
        sweptSats: 0,
        feeSats: 0,
        vsize: 0,
        txid: "",
      };
      ROWS.push(row);
      const chantoolsWindow = sc.mode === "highindex" ? HIGH_INDEX + 11 : 25;

      beforeAll(async () => {
        bd = await startBitcoind();
        await bd.mine(110);
        shim = await startShim({
          rpcUrl: bd.rpcUrl,
          cookiePath: bd.cookiePath,
          port: await freePort(),
          host: "127.0.0.1",
          feeRateSatPerVb: SHIM_FEE_RATE,
        });
        lnd = await startLnd({
          bitcoind: bd,
          mnemonic: sc.seed.mnemonic,
          ...(sc.seed.passphrase ? { aezeedPassphrase: sc.seed.passphrase } : {}),
        });
        await lnd.waitSynced();
        // Recovery side: only the words and the passphrase.
        const cs = await decipherMnemonic(sc.seed.mnemonic, sc.seed.passphrase);
        expect(hex(cs.entropy)).toBe(sc.seed.entropy_hex);
        master = masterFromEntropy(cs.entropy);
      });

      afterAll(async () => {
        if (lnd) {
          await tryDo(`${sc.id}: kill lnd`, () => lnd!.kill());
          await tryDo(`${sc.id}: delete lnddir`, () => lnd!.deleteDataDir());
        }
        if (shim) await tryDo(`${sc.id}: stop shim`, () => shim!.stop());
        if (bd) await tryDo(`${sc.id}: stop bitcoind`, () => bd!.stop());
      });

      it("1. lnd is up from the supplied aezeed with an empty wallet", async () => {
        expect((await lnd!.getInfo()).synced_to_chain).toBe(true);
        expect((await lnd!.walletBalance()).confirmedSat).toBe(0);
      });

      it("2. fund lnd: externals, NextAddr change=true, and spends for natural change", async () => {
        const b = bd!;
        const l = lnd!;
        let counter = 0;
        let funded = 0;
        const fund = async (addr: string, sats: number): Promise<void> => {
          await b.sendTo(addr, sats / 1e8);
          fundedAddrs.add(addr);
          funded += sats;
        };

        if (sc.mode === "highindex") {
          for (let i = 0; i <= HIGH_INDEX; i++) external.p2wkh.push(await l.newAddress("p2wkh"));
          await fund(external.p2wkh[HIGH_INDEX]!, HIGH_INDEX_SATS);
          for (const kind of ["np2wkh", "p2tr"] as const) {
            for (let i = 0; i < 4; i++) external[kind].push(await l.newAddress(kind));
            await fund(external[kind][3]!, 1_100_000 + 10_000 * ++counter);
          }
        } else {
          // 8 external per kind; the affected kind funded at 0,1,2,5,7, the others at 0,2,5.
          for (const kind of KINDS) {
            for (let i = 0; i < 8; i++) external[kind].push(await l.newAddress(kind));
            const idx = kind === sc.affectedKind ? [0, 1, 2, 5, 7] : [0, 2, 5];
            for (const i of idx) await fund(external[kind][i]!, 1_000_000 + 10_000 * ++counter + i);
          }
        }
        // Two NextAddr change=true addresses on the affected kind's scope. For np2wkh these
        // are the BIP0049Plus quirk: m/49'/0'/0'/1/i encoded as native P2WPKH.
        for (let i = 0; i < 2; i++) {
          const a = await l.nextAddr(sc.affectedKind, true);
          nextChange[sc.affectedKind].push(a);
          await fund(a, 800_000 + 10_000 * ++counter);
        }
        if (sc.affectedKind === "np2wkh") for (const a of nextChange.np2wkh) expect(a).toMatch(/^bcrt1q/);

        await b.mine(1);
        await l.waitSynced();
        await waitFor("lnd sees funding", async () => ((await l.walletBalance()).confirmedSat === funded ? true : undefined), {
          timeoutMs: 90_000,
        });

        // Spends so lnd itself produces change (p2wkh via FundPsbt UNSPECIFIED, p2tr via FundPsbt P2TR and SendCoins).
        const before = await l.listUnspent();
        const ofKind = (kind: AddressKind, n: number): LndUtxo[] => before.filter((u) => external[kind].includes(u.address)).slice(0, n);
        if (sc.mode === "highindex") {
          // Leave the index-299 coin alone.
          const [u] = ofKind("np2wkh", 1);
          await l.spendUtxos([{ txid: u!.txid, vout: u!.vout }], await b.newAddress(), Math.floor(u!.amountSat * 0.3), "p2wkh");
          const [v] = ofKind("p2tr", 1);
          await l.spendUtxos([{ txid: v!.txid, vout: v!.vout }], await b.newAddress(), Math.floor(v!.amountSat * 0.3), "p2tr");
        } else {
          const [x, y] = ofKind(sc.affectedKind, 2);
          await l.spendUtxos([{ txid: x!.txid, vout: x!.vout }], await b.newAddress("bech32m"), Math.floor(x!.amountSat * 0.4), "p2wkh");
          await l.spendUtxos([{ txid: y!.txid, vout: y!.vout }], await b.newAddress("legacy"), Math.floor(y!.amountSat * 0.35), "p2tr");
          await l.sendCoins(await b.newAddress("p2sh-segwit"), 123_456, 2);
        }
        await b.mine(1);
        await l.waitSynced();
        await waitFor("spends confirm", async () => ((await l.walletBalance()).unconfirmedSat === 0 ? true : undefined));
        lndUtxos = await l.listUnspent();
        lndSats = (await l.walletBalance()).confirmedSat;
        row.lndUtxos = lndUtxos.length;
        row.lndSats = lndSats;
        expect(lndUtxos.reduce((n, u) => n + u.amountSat, 0)).toBe(lndSats);
        const change = lndUtxos.filter((u) => !fundedAddrs.has(u.address)).map((u) => u.address);
        expect(change.length).toBeGreaterThanOrEqual(2);
        const held = new Set(lndUtxos.map((u) => u.address));
        for (const a of nextChange[sc.affectedKind]) expect(held.has(a)).toBe(true);
      });

      it("3. lnd dies and its data dir is deleted", async () => {
        await lnd!.kill();
        lnd!.deleteDataDir();
        expect(existsSync(lnd!.lnddir)).toBe(false);
      });

      it("4. chantools agrees with our derivation on every branch, and lnd's addresses sit where expected", async () => {
        chantools = await genImportScript(sc.seed.mnemonic, sc.seed.passphrase || undefined, chantoolsWindow, NETWORK);
        for (const b of ALL_BRANCHES) {
          const ours = deriveBranchAddresses(master!, NETWORK, b, 0, chantoolsWindow).map((a) => a.address);
          expect(ours, branchLabel(b)).toEqual(chantoolsBranch(chantools, b));
        }
        for (const kind of KINDS) {
          const ext = external[kind];
          expect(chantools[kind].external.slice(0, ext.length), `${kind} external`).toEqual(ext);
        }
        // NextAddr change=true: p2wkh and p2tr scopes hand out their own encoding; the nested scope hands out wpkh.
        const changeBranch: Branch =
          sc.affectedKind === "np2wkh"
            ? { purpose: 49, change: 1, kind: "p2wkh" }
            : { purpose: sc.affectedKind === "p2wkh" ? 84 : 86, change: 1, kind: sc.affectedKind };
        expect(chantoolsBranch(chantools, changeBranch).slice(0, 2)).toEqual(nextChange[sc.affectedKind]);
      });

      it("5. tier 100 then tier 2500 from the words through the shim: the UTXO set must equal lnd's exactly", async () => {
        const client = clientFor(shim!);
        const t1 = await measured(shim!, () => scan(deriverFor(master!), client, NETWORK, { window: TIER_1 }));
        row.tier1Sats = t1.result.totalSats;
        row.tier1Ms = t1.ms;
        row.tier1Requests = t1.requests;
        const highIndexCoin = (r: ScanResult): boolean =>
          r.utxos.some((u) => u.owner.path === `m/84'/0'/0'/0/${HIGH_INDEX}` && u.value === HIGH_INDEX_SATS);
        if (sc.mode === "highindex") {
          // Tier boundary: index 299 sits beyond a 100 gap on an otherwise unused branch, so tier 100 must
          // find every other coin and miss exactly that one; tier 2500 must then pick it up.
          expect(highIndexCoin(t1.result)).toBe(false);
          expect(t1.result.usedAddresses.some((a) => a.purpose === 84 && a.change === 0)).toBe(false);
          expect(t1.result.depth[branchLabel({ purpose: 84, change: 0, kind: "p2wkh" })]).toBe(TIER_1);
          expect(t1.result.totalSats).toBe(lndSats - HIGH_INDEX_SATS);
          expect(t1.result.utxos).toHaveLength(lndUtxos.length - 1);
        } else {
          expect(outpoints(t1.result.utxos)).toEqual(outpoints(lndUtxos));
          expect(t1.result.totalSats).toBe(lndSats);
        }

        const predicted = estimateScanCost(NETWORK, { window: TIER_2, resumeFrom: t1.result }).requests;
        const t2 = await measured(shim!, () => scan(deriverFor(master!), client, NETWORK, { window: TIER_2, resumeFrom: t1.result }));
        result = t2.result;
        row.tier2Ms = t2.ms;
        row.tier2Requests = t2.requests;
        row.tier2Predicted = predicted;
        row.recoveredUtxos = result.utxos.length;
        row.recoveredSats = result.totalSats;
        const missing = lndUtxos.filter((u) => !result!.utxos.some((r) => r.txid === u.txid && r.vout === u.vout));
        if (missing.length) console.log(`[e2e seeds ${sc.id}] missing: ${JSON.stringify(missing)}`);
        expect(outpoints(result.utxos)).toEqual(outpoints(lndUtxos));
        expect(result.totalSats).toBe(lndSats);
        const byOutpoint = new Map(lndUtxos.map((u) => [`${u.txid}:${u.vout}`, u]));
        for (const u of result.utxos) expect(u.owner.address).toBe(byOutpoint.get(`${u.txid}:${u.vout}`)!.address);
        const affPurpose = { np2wkh: 49, p2wkh: 84, p2tr: 86 }[sc.affectedKind];
        expect(result.utxos.some((u) => u.owner.purpose === affPurpose)).toBe(true);
        // The NextAddr change=true coins carry the right branch.
        for (const a of nextChange[sc.affectedKind]) {
          const u = result.utxos.find((x) => x.owner.address === a);
          expect(u, `recovered ${a}`).toBeDefined();
          expect(branchOf(u!.owner)).toEqual(
            sc.affectedKind === "np2wkh"
              ? { purpose: 49, change: 1, kind: "p2wkh" }
              : { purpose: affPurpose, change: 1, kind: sc.affectedKind },
          );
        }
        if (sc.mode === "highindex") {
          expect(highIndexCoin(result)).toBe(true);
          expect(result.depth[branchLabel({ purpose: 84, change: 0, kind: "p2wkh" })]).toBe(HIGH_INDEX + 1 + TIER_2);
          // The one new hit at tier 2500 costs its UTXO lookup plus the branch extension past 299.
          expect(t2.requests).toBeGreaterThan(predicted);
        } else {
          // Nothing new at tier 2500, so its cost is exactly the address lookups estimateScanCost counts.
          expect(t2.requests).toBe(predicted);
        }
      });

      it("6. sweep at the shim's fee rate empties every address; rescan is zero", async () => {
        const b = bd!;
        const client = clientFor(shim!);
        const r = result!;
        const feeRate = await fastestFeeRate(client);
        expect(feeRate).toBe(SHIM_FEE_RATE);
        const destination = await b.newAddress("bech32");
        const plan = planSweep(r.utxos, destination, feeRate, { tipHeight: await client.getTipHeight() });
        const signed = signSweep(plan, keyFor(master!));
        sweep = signed;
        expect(signed.feeSats).toBe(Math.ceil(signed.vsize * SHIM_FEE_RATE));
        const txid = await client.broadcast(signed.rawTxHex);
        expect(txid).toBe(signed.txid);
        await b.mine(1);
        row.txid = signed.txid;
        row.sweptSats = signed.outputSats;
        row.feeSats = signed.feeSats;
        row.vsize = signed.vsize;
        expect((await b.scanAddresses([destination])).totalSats).toBe(r.totalSats - signed.feeSats);
        expect((await b.getRawTransaction(signed.txid) as { vsize: number }).vsize).toBe(signed.vsize);
        // lnd's own address list is the oracle: everything it ever held must be empty now.
        const left = await b.scanAddresses([...new Set(lndUtxos.map((u) => u.address))]);
        expect(left.totalSats).toBe(0);
        const again = await scan(deriverFor(master!), client, NETWORK, { window: TIER_2 });
        expect(again.utxos).toHaveLength(0);
        expect(again.totalSats).toBe(0);
      });

      if (sc.mode === "passphrase") {
        it("7. the same words without the passphrase, or with a near miss, do not decipher", async () => {
          await expect(decipherMnemonic(sc.seed.mnemonic, "")).rejects.toBeInstanceOf(InvalidPassphraseError);
          await expect(decipherMnemonic(sc.seed.mnemonic, sc.seed.passphrase.replace("ä", "a"))).rejects.toBeInstanceOf(
            InvalidPassphraseError,
          );
        });
      }
    });
  }
});
