import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compareTxs, fetchTransactions, netAmount, ownAddressesOf, toAddressTx, type RawTx } from "../../src/chain";
import type { AddressTx, ChainClient } from "../../src/types";

const FIX = new URL("./chain-fixtures/", import.meta.url);
const fixtureJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, FIX), "utf8")) as T;

const WITH_MEMPOOL = "tb1q2fwm9cxug27cq4uslaeepwcux6trj8pt266mwz";

const tx = (txid: string, o: Partial<AddressTx> = {}): AddressTx => ({
  txid,
  status: { confirmed: true, blockHeight: 10 },
  fee: 1,
  vin: [],
  vout: [],
  ...o,
});

function clientWith(history: Record<string, AddressTx[]>) {
  const calls: string[] = [];
  const client: ChainClient = {
    baseUrl: "http://fake/",
    network: "signet",
    getTipHeight: async () => 0,
    getAddressStats: async () => ({ chainTxCount: 0, mempoolTxCount: 0, fundedSats: 0, spentSats: 0 }),
    getAddressUtxos: async () => [],
    getAddressTxs: async (a) => {
      calls.push(a);
      return history[a] ?? [];
    },
    getFeeEstimates: async () => ({}),
    broadcast: async () => "",
  };
  return { client, calls };
}

describe("netAmount", () => {
  it("cross-checks against real mempool.space data: funding then mempool spend", () => {
    const raw = fixtureJson<RawTx[]>("signet-address-txs-with-mempool.json");
    const stats = fixtureJson<{ chain_stats: { funded_txo_sum: number }; mempool_stats: { spent_txo_sum: number } }>(
      "signet-address-stats-with-mempool.json",
    );
    const own = new Set([WITH_MEMPOOL]);
    const [spend, fund] = raw.map(toAddressTx);
    expect(netAmount(fund!, own)).toBe(stats.chain_stats.funded_txo_sum);
    expect(netAmount(spend!, own)).toBe(-stats.mempool_stats.spent_txo_sum);
    expect(ownAddressesOf(fund!, own)).toEqual([WITH_MEMPOOL]);
  });

  it("nets inputs and outputs across several own addresses, ignoring foreign ones", () => {
    const own = new Set(["A", "B"]);
    const t = tx("t", {
      vin: [
        { txid: "p", vout: 0, address: "A", value: 1000 },
        { txid: "p", vout: 1, address: "X", value: 5000 },
        { txid: "c", vout: 0 }, // coinbase-style, no prevout
      ],
      vout: [
        { address: "B", value: 300, scriptPubKey: "00" },
        { address: "A", value: 200, scriptPubKey: "00" },
        { address: "Y", value: 5400, scriptPubKey: "00" },
        { value: 0, scriptPubKey: "6a" }, // op_return, no address
      ],
    });
    expect(netAmount(t, own)).toBe(-500);
    expect(ownAddressesOf(t, own)).toEqual(["A", "B"]);
  });
});

describe("compareTxs", () => {
  it("orders unconfirmed first, then newest block, then txid", () => {
    const list = [
      tx("b", { status: { confirmed: true, blockHeight: 5 } }),
      tx("a", { status: { confirmed: true, blockHeight: 5 } }),
      tx("z", { status: { confirmed: false } }),
      tx("c", { status: { confirmed: true, blockHeight: 9 } }),
    ].sort(compareTxs);
    expect(list.map((t) => t.txid)).toEqual(["z", "c", "a", "b"]);
  });
});

describe("fetchTransactions", () => {
  it("de-duplicates transactions shared between addresses and computes net per tx", async () => {
    const shared = tx("s", {
      vin: [{ txid: "p", vout: 0, address: "A", value: 1000 }],
      vout: [
        { address: "B", value: 900, scriptPubKey: "00" },
        { address: "Z", value: 50, scriptPubKey: "00" },
      ],
      status: { confirmed: true, blockHeight: 20 },
    });
    const fundA = tx("f", { vout: [{ address: "A", value: 1000, scriptPubKey: "00" }], status: { confirmed: true, blockHeight: 19 } });
    const pending = tx("m", {
      vin: [{ txid: "s", vout: 0, address: "B", value: 900 }],
      vout: [{ address: "Q", value: 850, scriptPubKey: "00" }],
      status: { confirmed: false },
    });
    const { client, calls } = clientWith({ A: [shared, fundA], B: [pending, shared] });
    const owners = [
      { address: "A" },
      { address: "B" },
      "A", // duplicates collapse
    ] as unknown as Parameters<typeof fetchTransactions>[1];
    const out = await fetchTransactions(client, owners);
    expect(calls.sort()).toEqual(["A", "B"]);
    expect(out.map((t) => t.txid)).toEqual(["m", "s", "f"]);
    expect(out.map((t) => t.netSats)).toEqual([-900, -100, 1000]);
    expect(out[1]!.ownAddresses).toEqual(["A", "B"]);
  });

  it("prefers the confirmed view when one address saw the tx confirm and another did not", async () => {
    const pending = tx("t", { status: { confirmed: false } });
    const done = tx("t", { status: { confirmed: true, blockHeight: 3 } });
    const { client } = clientWith({ A: [pending], B: [done] });
    const out = await fetchTransactions(client, ["A", "B"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.status.confirmed).toBe(true);
  });

  it("honours an already aborted signal", async () => {
    const { client, calls } = clientWith({ A: [tx("t")] });
    const c = new AbortController();
    c.abort();
    await expect(fetchTransactions(client, ["A"], { signal: c.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual([]);
  });
});
