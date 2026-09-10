/**
 * Runs the regtest Esplora shim against a fake bitcoind JSON-RPC and checks
 * that its responses have exactly the shape of the recorded mempool.space
 * fixtures, and that EsploraClient can drive it end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RpcError, esploraScriptType, scriptToAsm, start, type EsploraTx, type RpcFn, type Shim } from "../e2e/esplora-shim";
import { EsploraClient } from "../../src/chain";

const FIX = new URL("./chain-fixtures/", import.meta.url);
const fixtureJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, FIX), "utf8")) as T;

// ---- fake regtest chain -----------------------------------------------------

const A = "bcrt1qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bcrt1qbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "bcrt1qcccccccccccccccccccccccccccccccccccccc";
const D = "bcrt1qdddddddddddddddddddddddddddddddddddddd";
const NOBODY = "bcrt1qnobodynobodynobodynobodynobodynobody1";

const spkHex = (addr: string) => "0014" + addr.charCodeAt(6).toString(16).padStart(2, "0").repeat(20);
const spk = (addr: string) => ({ asm: `0 ${spkHex(addr).slice(4)}`, hex: spkHex(addr), type: "witness_v0_keyhash", address: addr });
const id = (s: string) => s.padEnd(64, "f"); // distinct fake ids; "0" padding would make cb1 == cb10

interface FakeVin {
  coinbase?: string;
  txid?: string;
  vout?: number;
  scriptSig?: { asm: string; hex: string };
  txinwitness?: string[];
  sequence: number;
  prevout?: { generated: boolean; height: number; value: number; scriptPubKey: ReturnType<typeof spk> };
}
interface FakeTx {
  txid: string;
  version: number;
  size: number;
  weight: number;
  locktime: number;
  vin: FakeVin[];
  vout: { value: number; n: number; scriptPubKey: ReturnType<typeof spk> }[];
  fee?: number;
}
interface FakeBlock {
  hash: string;
  height: number;
  time: number;
  tx: FakeTx[];
}

function makeChain() {
  const txs = new Map<string, FakeTx>();
  const blocks: FakeBlock[] = [];
  const heightOf = new Map<string, number>();
  const mempool: string[] = [];

  const coinbase = (h: number, to: string): FakeTx => ({
    txid: id(`cb${h}`),
    version: 2,
    size: 120,
    weight: 480,
    locktime: 0,
    vin: [{ coinbase: `0${h.toString(16).padStart(2, "0")}`, txinwitness: ["00".repeat(32)], sequence: 4294967295 }],
    vout: [{ value: 50, n: 0, scriptPubKey: spk(to) }],
  });
  const spend = (txid: string, from: { txid: string; vout: number }, outs: [string, number][], fee: number): FakeTx => {
    const prev = txs.get(from.txid)!;
    const prevOut = prev.vout[from.vout]!;
    return {
      txid: id(txid),
      version: 2,
      size: 222,
      weight: 561,
      locktime: 0,
      vin: [
        {
          txid: from.txid,
          vout: from.vout,
          scriptSig: { asm: "", hex: "" },
          txinwitness: ["30440220" + "11".repeat(68), "02" + "22".repeat(32)],
          sequence: 4294967293,
          prevout: { generated: false, height: heightOf.get(from.txid) ?? 0, value: prevOut.value, scriptPubKey: prevOut.scriptPubKey },
        },
      ],
      vout: outs.map(([to, value], n) => ({ value, n, scriptPubKey: spk(to) })),
      fee,
    };
  };
  const addBlock = (list: FakeTx[]) => {
    const height = blocks.length;
    const block: FakeBlock = { hash: id(`b${height}`), height, time: 1_700_000_000 + height * 600, tx: list };
    blocks.push(block);
    for (const t of list) {
      txs.set(t.txid, t);
      heightOf.set(t.txid, height);
    }
  };

  addBlock([coinbase(0, A)]);
  // Block 1: coinbase to D, plus A pays B 20 and takes 29.9999 change.
  const cb1 = coinbase(1, D);
  txs.set(cb1.txid, cb1);
  const t1 = spend("t1", { txid: id("cb0"), vout: 0 }, [[B, 20], [A, 29.9999]], 0.0001);
  addBlock([cb1, t1]);
  for (let h = 2; h <= 30; h++) addBlock([coinbase(h, D)]);
  // Mempool: B pays C.
  const m1 = spend("m1", { txid: id("t1"), vout: 0 }, [[C, 19.9999]], 0.0001);
  txs.set(m1.txid, m1);
  mempool.push(m1.txid);

  const confirmedSpent = new Set<string>();
  for (const b of blocks) for (const t of b.tx) for (const v of t.vin) if (v.txid !== undefined) confirmedSpent.add(`${v.txid}:${v.vout}`);

  let stripPrevout = false;
  const rpc: RpcFn = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const r = (v: unknown) => v as T;
    switch (method) {
      case "getblockcount":
        return r(blocks.length - 1);
      case "getbestblockhash":
        return r(blocks[blocks.length - 1]!.hash);
      case "getblockhash": {
        const b = blocks[params[0] as number];
        if (!b) throw new RpcError(-8, "Block height out of range");
        return r(b.hash);
      }
      case "getblockheader":
        return r({ time: blocks.find((b) => b.hash === params[0])!.time });
      case "getblock": {
        const b = blocks.find((x) => x.hash === params[0])!;
        const tx = stripPrevout ? b.tx.map((t) => ({ ...t, fee: undefined, vin: t.vin.map(({ prevout: _p, ...v }) => v) })) : b.tx;
        return r({ ...b, tx });
      }
      case "getrawmempool":
        return r([...mempool]);
      case "getrawtransaction": {
        const t = txs.get(params[0] as string);
        if (!t) throw new RpcError(-5, "No such mempool or blockchain transaction");
        if (params[1] === 0) return r("02000000" + "ab".repeat(40));
        return r(t);
      }
      case "validateaddress":
        return r({ isvalid: (params[0] as string).startsWith("bcrt1q") });
      case "scantxoutset": {
        const m = /^addr\((.+)\)$/.exec((params[1] as string[])[0]!);
        const addr = m![1]!;
        const unspents: unknown[] = [];
        for (const b of blocks)
          for (const t of b.tx)
            t.vout.forEach((o, n) => {
              if (o.scriptPubKey.address === addr && !confirmedSpent.has(`${t.txid}:${n}`))
                unspents.push({ txid: t.txid, vout: n, scriptPubKey: o.scriptPubKey.hex, desc: `addr(${addr})#x`, amount: o.value, coinbase: false, height: b.height });
            });
        return r({ success: true, height: blocks.length - 1, unspents, total_amount: 0 });
      }
      case "estimatesmartfee":
        return r({ errors: ["Insufficient data or no feerate found"], blocks: params[0] });
      case "sendrawtransaction": {
        const hex = params[0] as string;
        if (hex === "deadbeef") throw new RpcError(-22, "TX decode failed. Make sure the tx has at least one input.");
        const m2 = spend("m2", { txid: id("m1"), vout: 0 }, [[D, 19.9998]], 0.0001);
        txs.set(m2.txid, m2);
        mempool.push(m2.txid);
        return r(m2.txid);
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  };
  return { rpc, setStripPrevout: (v: boolean) => (stripPrevout = v) };
}

// ---- shape helpers ------------------------------------------------------------

/** Sorted list of key paths; arrays descend into their first element as "[]". */
function shape(v: unknown, prefix = ""): string[] {
  if (Array.isArray(v)) return v.length ? shape(v[0], `${prefix}[]`) : [`${prefix}[]`];
  if (v !== null && typeof v === "object") {
    const out: string[] = [];
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out.push(`${prefix}.${k}`);
      out.push(...shape(val, `${prefix}.${k}`));
    }
    return out.sort();
  }
  return [];
}
const without = (paths: string[], drop: string[]) => paths.filter((p) => !drop.some((d) => p === d || p.startsWith(`${d}.`)));

// ---- tests ----------------------------------------------------------------------

describe("esplora-shim", () => {
  let shim: Shim;
  let chain: ReturnType<typeof makeChain>;
  const get = async (path: string) => {
    const res = await fetch(shim.baseUrl + path);
    return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
  };
  const getJson = async <T,>(path: string): Promise<T> => {
    const r = await get(path);
    expect(r.status, `${path}: ${r.text}`).toBe(200);
    return JSON.parse(r.text) as T;
  };

  beforeAll(async () => {
    chain = makeChain();
    shim = await start({ rpc: chain.rpc });
  });
  afterAll(async () => {
    await shim.stop();
  });

  it("serves tip height as plain text with CORS", async () => {
    const res = await fetch(shim.baseUrl + "blocks/tip/height");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toBe("30");
    expect((await get("blocks/tip/hash")).text).toBe(id("b30"));
  });

  it("address stats match the mempool.space shape and are computed like Esplora", async () => {
    const fixture = fixtureJson<unknown>("signet-address-stats-used.json");
    const a = await getJson<Record<string, unknown>>(`address/${A}`);
    expect(shape(a)).toEqual(shape(fixture));
    expect(a).toEqual({
      address: A,
      chain_stats: { funded_txo_count: 2, funded_txo_sum: 50e8 + 29_9999_0000, spent_txo_count: 1, spent_txo_sum: 50e8, tx_count: 2 },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
    });
    // B mirrors the recorded "funded on chain, spent in mempool" fixture.
    const b = await getJson<{ chain_stats: Record<string, number>; mempool_stats: Record<string, number> }>(`address/${B}`);
    expect(b.chain_stats).toEqual({ funded_txo_count: 1, funded_txo_sum: 20e8, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 });
    expect(b.mempool_stats).toEqual({ funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 1, spent_txo_sum: 20e8, tx_count: 1 });
    const c = await getJson<{ chain_stats: { tx_count: number }; mempool_stats: Record<string, number> }>(`address/${C}`);
    expect(c.chain_stats.tx_count).toBe(0);
    expect(c.mempool_stats).toEqual({ funded_txo_count: 1, funded_txo_sum: 19_9999_0000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 });
    expect(await getJson<unknown>(`address/${NOBODY}`)).toEqual(JSON.parse(JSON.stringify(fixtureJson("signet-address-stats-unused.json")).replace(/tb1q[a-z0-9]+/, NOBODY)));
  });

  it("utxos match the fixture shape; mempool spends are excluded and mempool outputs included", async () => {
    const fixture = fixtureJson<unknown[]>("signet-address-utxo-used.json");
    const a = await getJson<unknown[]>(`address/${A}/utxo`);
    expect(shape(a)).toEqual(shape(fixture));
    expect(a).toEqual([
      { txid: id("t1"), vout: 1, status: { confirmed: true, block_height: 1, block_hash: id("b1"), block_time: 1_700_000_600 }, value: 29_9999_0000 },
    ]);
    expect(await getJson<unknown[]>(`address/${B}/utxo`)).toEqual([]);
    expect(await getJson<unknown[]>(`address/${C}/utxo`)).toEqual([{ txid: id("m1"), vout: 0, status: { confirmed: false }, value: 19_9999_0000 }]);
    expect(await getJson<unknown[]>(`address/${D}/utxo`)).toHaveLength(30);
  });

  it("transactions match the fixture shape (mempool.space adds only `sigops`)", async () => {
    const fixture = fixtureJson<EsploraTx[]>("signet-address-txs-with-mempool.json");
    const [fixUnconfirmed, fixConfirmed] = fixture;
    const txs = await getJson<EsploraTx[]>(`address/${B}/txs`);
    expect(txs.map((t) => t.txid)).toEqual([id("m1"), id("t1")]); // mempool first
    const [unconfirmed, confirmed] = txs;
    expect(shape(confirmed)).toEqual(without(shape(fixConfirmed), [".sigops"]));
    expect(shape(unconfirmed)).toEqual(without(shape(fixUnconfirmed), [".sigops"]));
    expect(confirmed!.status).toEqual({ confirmed: true, block_height: 1, block_hash: id("b1"), block_time: 1_700_000_600 });
    expect(confirmed!.fee).toBe(10000);
    expect(confirmed!.vin[0]!.prevout).toMatchObject({ scriptpubkey_address: A, value: 50e8, scriptpubkey_type: "v0_p2wpkh" });
    expect(confirmed!.vin[0]!.prevout!.scriptpubkey_asm).toBe(`OP_0 OP_PUSHBYTES_20 ${spkHex(A).slice(4)}`);
    expect(confirmed!.vout.map((o) => o.scriptpubkey_address)).toEqual([B, A]);
    expect(unconfirmed!.status).toEqual({ confirmed: false });
  });

  it("renders coinbase inputs like Esplora", async () => {
    const txs = await getJson<EsploraTx[]>(`address/${A}/txs`);
    const cb = txs.find((t) => t.txid === id("cb0"))!;
    expect(cb.vin[0]).toMatchObject({ txid: "0".repeat(64), vout: 4294967295, prevout: null, is_coinbase: true, scriptsig: "000" });
    expect(cb.fee).toBe(0);
  });

  it("pages confirmed history 25 at a time via /txs/chain/:last_seen_txid", async () => {
    const page1 = await getJson<EsploraTx[]>(`address/${D}/txs`);
    expect(page1).toHaveLength(25);
    expect(page1[0]!.status.block_height).toBe(30); // newest first
    const page2 = await getJson<EsploraTx[]>(`address/${D}/txs/chain/${page1[24]!.txid}`);
    expect(page2).toHaveLength(5);
    expect(page2[4]!.status.block_height).toBe(1);
    expect(await getJson<EsploraTx[]>(`address/${D}/txs/chain/${page2[4]!.txid}`)).toEqual([]);
    expect(await getJson<EsploraTx[]>(`address/${D}/txs/mempool`)).toEqual([]);
    expect((await getJson<EsploraTx[]>(`address/${D}/txs/chain`)).map((t) => t.txid)).toEqual(page1.map((t) => t.txid));
  });

  it("fee endpoints match both mempool.space shapes", async () => {
    const rec = await getJson<Record<string, number>>("v1/fees/recommended");
    expect(Object.keys(rec)).toEqual(Object.keys(fixtureJson<object>("signet-v1-fees-recommended.json")));
    const est = await getJson<Record<string, number>>("fee-estimates");
    expect(Object.keys(est).sort()).toEqual(Object.keys(fixtureJson<object>("signet-fee-estimates.json")).sort());
    expect(Object.values(est).every((v) => v >= 1)).toBe(true);
  });

  it("errors use Esplora's text/plain bodies", async () => {
    const errors = fixtureJson<Record<string, { status: number; body: string }>>("error-responses.json");
    const bad = await get("address/notanaddress");
    expect(bad.status).toBe(400);
    expect(bad.type).toMatch(/^text\/plain/);
    expect(bad.text).toBe(errors["GET /address/notanaddress"]!.body);
    expect((await get("nope")).status).toBe(404);
    expect((await get(`tx/${"ff".repeat(32)}`)).status).toBe(404);
  });

  it("POST /tx rejects with the exact mempool.space error format and accepts a good tx", async () => {
    const errors = fixtureJson<Record<string, { status: number; body: string }>>("error-responses.json");
    const expected = errors["POST /tx (body: deadbeef) on mempool.space"]!;
    const res = await fetch(shim.baseUrl + "tx", { method: "POST", body: "deadbeef", headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(expected.status);
    expect(await res.text()).toBe(expected.body);

    const ok = await fetch(shim.baseUrl + "tx", { method: "POST", body: "02000000" + "00".repeat(60) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(id("m2"));
    // Visible immediately as unconfirmed on the receiving address.
    const d = await getJson<{ mempool_stats: { funded_txo_count: number } }>(`address/${D}`);
    expect(d.mempool_stats.funded_txo_count).toBe(1);
    expect(await getJson<EsploraTx[]>(`address/${D}/txs/mempool`)).toHaveLength(1);
    // And C's mempool utxo is now spent in the mempool.
    expect(await getJson<unknown[]>(`address/${C}/utxo`)).toEqual([]);
  });

  it("serves /tx/:txid, /tx/:txid/status and /tx/:txid/hex", async () => {
    const t = await getJson<EsploraTx>(`tx/${id("t1")}`);
    expect(t.txid).toBe(id("t1"));
    expect(await getJson<unknown>(`tx/${id("t1")}/status`)).toEqual(t.status);
    expect((await get(`tx/${id("t1")}/hex`)).text).toMatch(/^02000000/);
  });

  it("EsploraClient drives the shim end to end", async () => {
    const client = new EsploraClient(shim.baseUrl, { network: "regtest" });
    expect(await client.getTipHeight()).toBe(30);
    const txs = await client.getAddressTxs(D);
    expect(txs).toHaveLength(31); // 30 coinbases + m2 from the broadcast test
    expect(new Set(txs.map((t) => t.txid)).size).toBe(31);
    expect(await client.getAddressStats(B)).toEqual({ chainTxCount: 1, mempoolTxCount: 1, fundedSats: 20e8, spentSats: 20e8 });
    expect(await client.getFeeEstimates()).toEqual({ "1": 1, "3": 1, "6": 1, "144": 1, "1008": 1 });
    await expect(client.broadcast("deadbeef")).rejects.toThrow(/TX decode failed/);
  });

  it("fills prevouts and fees itself when the node does not supply them", async () => {
    chain.setStripPrevout(true);
    const fresh = await start({ rpc: chain.rpc });
    try {
      const res = await fetch(`${fresh.baseUrl}address/${B}/txs`);
      const txs = (await res.json()) as EsploraTx[];
      const t1 = txs.find((t) => t.txid === id("t1"))!;
      expect(t1.fee).toBe(10000);
      expect(t1.vin[0]!.prevout).toMatchObject({ scriptpubkey_address: A, value: 50e8 });
    } finally {
      chain.setStripPrevout(false);
      await fresh.stop();
    }
  });
});

describe("shim helpers", () => {
  it("scriptToAsm matches Esplora's asm rendering", () => {
    expect(scriptToAsm("0014c31172357cbe267cdcc64fcaad7db875e5947e14")).toBe("OP_0 OP_PUSHBYTES_20 c31172357cbe267cdcc64fcaad7db875e5947e14");
    expect(scriptToAsm("5120fb227c6729283411707d829545b52a14466b3bfd27c6b7b31346b39bfe4c64d4")).toBe(
      "OP_PUSHNUM_1 OP_PUSHBYTES_32 fb227c6729283411707d829545b52a14466b3bfd27c6b7b31346b39bfe4c64d4",
    );
    expect(scriptToAsm("76a914" + "00".repeat(20) + "88ac")).toBe(`OP_DUP OP_HASH160 OP_PUSHBYTES_20 ${"00".repeat(20)} OP_EQUALVERIFY OP_CHECKSIG`);
    expect(scriptToAsm("6a4c03010203")).toBe("OP_RETURN OP_PUSHDATA1 010203");
  });
  it("maps core script types to Esplora's", () => {
    expect(esploraScriptType("witness_v0_keyhash")).toBe("v0_p2wpkh");
    expect(esploraScriptType("witness_v1_taproot")).toBe("v1_p2tr");
    expect(esploraScriptType("scripthash")).toBe("p2sh");
    expect(esploraScriptType("nulldata")).toBe("op_return");
  });
});
