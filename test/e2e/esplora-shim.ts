/**
 * Esplora-compatible HTTP shim over a regtest bitcoind JSON-RPC.
 *
 * Serves exactly the endpoints src/chain/esplora.ts uses, with response shapes
 * matching the mempool.space / Esplora fixtures in test/unit/chain-fixtures.
 * Address history comes from an in-memory index built by walking blocks from
 * `startHeight` and watching the mempool (regtest chains are short). Confirmed
 * UTXOs come from `scantxoutset`, adjusted for mempool spends and mempool
 * outputs so /utxo behaves like Esplora's.
 *
 * Auth: cookie file, or rpcuser/rpcpassword. Options first, then env:
 *   BITCOIND_RPC_URL (or BITCOIND_RPC_HOST + BITCOIND_RPC_PORT)
 *   BITCOIND_RPC_COOKIE (path) or BITCOIND_RPC_USER + BITCOIND_RPC_PASSWORD
 *   ESPLORA_SHIM_PORT (default 0 = random free port)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

export type RpcFn = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;

export interface ShimOptions {
  /** e.g. http://127.0.0.1:18443 */
  rpcUrl?: string;
  rpcHost?: string;
  rpcPort?: number;
  cookiePath?: string;
  rpcUser?: string;
  rpcPassword?: string;
  /** Inject an RPC function instead of talking HTTP (tests). */
  rpc?: RpcFn;
  /** Port to listen on. Default 0 (random). */
  port?: number;
  host?: string;
  /** First block height to index. Default 0. */
  startHeight?: number;
  /** Log requests to stderr. */
  verbose?: boolean;
  /**
   * When set, /fee-estimates and /v1/fees/recommended report this sat/vB for every
   * target instead of asking bitcoind (whose regtest estimates are absent on a
   * fresh chain and arbitrary once blocks carry fee-paying transactions). The e2e
   * harness pins a non-trivial value so the fee path is exercised deterministically.
   * Unset: bitcoind's estimate, or 1 sat/vB when it has none.
   */
  feeRateSatPerVb?: number;
}

export interface Shim {
  /** Always ends with a slash, e.g. http://127.0.0.1:38731/ */
  readonly baseUrl: string;
  readonly port: number;
  /** Re-index new blocks and mempool now (every request does this anyway). */
  sync(): Promise<void>;
  /** HTTP requests served so far (every method and path). Lets tests check scan request budgets. */
  readonly requests: number;
  stop(): Promise<void>;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

// ---- Esplora JSON shapes ---------------------------------------------------

export interface EsploraStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}
export interface EsploraVout {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}
export interface EsploraVin {
  txid: string;
  vout: number;
  prevout: EsploraVout | null;
  scriptsig: string;
  scriptsig_asm: string;
  witness: string[];
  is_coinbase: boolean;
  sequence: number;
}
export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  vin: EsploraVin[];
  vout: EsploraVout[];
  size: number;
  weight: number;
  fee: number;
  status: EsploraStatus;
}
export interface EsploraUtxo {
  txid: string;
  vout: number;
  status: EsploraStatus;
  value: number;
}
interface StatsBucket {
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;
}
export interface EsploraAddressStats {
  address: string;
  chain_stats: StatsBucket;
  mempool_stats: StatsBucket;
}

// ---- bitcoind JSON shapes (subset) -----------------------------------------

interface CoreScriptPubKey {
  asm: string;
  hex: string;
  type: string;
  address?: string;
}
interface CoreVin {
  coinbase?: string;
  txid?: string;
  vout?: number;
  scriptSig?: { asm: string; hex: string };
  txinwitness?: string[];
  sequence: number;
  prevout?: { value: number; scriptPubKey: CoreScriptPubKey };
}
interface CoreTx {
  txid: string;
  version: number;
  size: number;
  weight: number;
  locktime: number;
  vin: CoreVin[];
  vout: { value: number; n: number; scriptPubKey: CoreScriptPubKey }[];
  fee?: number;
}
interface CoreBlock {
  hash: string;
  height: number;
  time: number;
  tx: CoreTx[];
}

const COINBASE_TXID = "0".repeat(64);
const ESPLORA_PAGE = 25;
const FEE_TARGETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 144, 504, 1008];

export function btcToSats(btc: number): number {
  return Math.round(btc * 1e8);
}

/** Core's scriptPubKey.type -> Esplora's scriptpubkey_type. */
export function esploraScriptType(coreType: string): string {
  switch (coreType) {
    case "witness_v0_keyhash":
      return "v0_p2wpkh";
    case "witness_v0_scripthash":
      return "v0_p2wsh";
    case "witness_v1_taproot":
      return "v1_p2tr";
    case "pubkeyhash":
      return "p2pkh";
    case "scripthash":
      return "p2sh";
    case "pubkey":
      return "p2pk";
    case "multisig":
      return "multisig";
    case "nulldata":
      return "op_return";
    case "anchor":
      return "anchor";
    case "witness_unknown":
      return "unknown";
    default:
      return "unknown";
  }
}

const OPCODE_NAMES: Record<number, string> = {
  0x00: "OP_0",
  0x4f: "OP_PUSHNUM_NEG1",
  0x61: "OP_NOP",
  0x63: "OP_IF",
  0x64: "OP_NOTIF",
  0x67: "OP_ELSE",
  0x68: "OP_ENDIF",
  0x69: "OP_VERIFY",
  0x6a: "OP_RETURN",
  0x6b: "OP_TOALTSTACK",
  0x6c: "OP_FROMALTSTACK",
  0x6d: "OP_2DROP",
  0x6e: "OP_2DUP",
  0x73: "OP_IFDUP",
  0x74: "OP_DEPTH",
  0x75: "OP_DROP",
  0x76: "OP_DUP",
  0x77: "OP_NIP",
  0x78: "OP_OVER",
  0x79: "OP_PICK",
  0x7a: "OP_ROLL",
  0x7b: "OP_ROT",
  0x7c: "OP_SWAP",
  0x7d: "OP_TUCK",
  0x82: "OP_SIZE",
  0x87: "OP_EQUAL",
  0x88: "OP_EQUALVERIFY",
  0x8b: "OP_1ADD",
  0x8c: "OP_1SUB",
  0x8f: "OP_NEGATE",
  0x90: "OP_ABS",
  0x91: "OP_NOT",
  0x92: "OP_0NOTEQUAL",
  0x93: "OP_ADD",
  0x94: "OP_SUB",
  0x9a: "OP_BOOLAND",
  0x9b: "OP_BOOLOR",
  0x9c: "OP_NUMEQUAL",
  0x9d: "OP_NUMEQUALVERIFY",
  0x9e: "OP_NUMNOTEQUAL",
  0x9f: "OP_LESSTHAN",
  0xa0: "OP_GREATERTHAN",
  0xa1: "OP_LESSTHANOREQUAL",
  0xa2: "OP_GREATERTHANOREQUAL",
  0xa3: "OP_MIN",
  0xa4: "OP_MAX",
  0xa5: "OP_WITHIN",
  0xa6: "OP_RIPEMD160",
  0xa7: "OP_SHA1",
  0xa8: "OP_SHA256",
  0xa9: "OP_HASH160",
  0xaa: "OP_HASH256",
  0xab: "OP_CODESEPARATOR",
  0xac: "OP_CHECKSIG",
  0xad: "OP_CHECKSIGVERIFY",
  0xae: "OP_CHECKMULTISIG",
  0xaf: "OP_CHECKMULTISIGVERIFY",
  0xb1: "OP_CLTV",
  0xb2: "OP_CSV",
  0xba: "OP_CHECKSIGADD",
};

/** Esplora / rust-bitcoin style asm: "OP_0 OP_PUSHBYTES_20 <hex>". */
export function scriptToAsm(hex: string): string {
  const bytes = hexToBytes(hex);
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i]!;
    i++;
    if (op >= 0x01 && op <= 0x4b) {
      parts.push(`OP_PUSHBYTES_${op}`, bytesToHex(bytes.subarray(i, i + op)));
      i += op;
    } else if (op === 0x4c || op === 0x4d || op === 0x4e) {
      const width = op === 0x4c ? 1 : op === 0x4d ? 2 : 4;
      let n = 0;
      for (let k = 0; k < width; k++) n |= (bytes[i + k] ?? 0) << (8 * k);
      i += width;
      parts.push(`OP_PUSHDATA${width === 1 ? "1" : width === 2 ? "2" : "4"}`, bytesToHex(bytes.subarray(i, i + n)));
      i += n;
    } else if (op >= 0x51 && op <= 0x60) {
      parts.push(`OP_PUSHNUM_${op - 0x50}`);
    } else {
      parts.push(OPCODE_NAMES[op] ?? (op >= 0xb0 && op <= 0xb9 ? `OP_NOP${op - 0xb0 + 1}` : `OP_RETURN_${op}`));
    }
  }
  return parts.join(" ");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function coreVoutToEsplora(spk: CoreScriptPubKey, valueBtc: number): EsploraVout {
  const out: EsploraVout = {
    scriptpubkey: spk.hex,
    scriptpubkey_asm: scriptToAsm(spk.hex),
    scriptpubkey_type: esploraScriptType(spk.type),
    value: btcToSats(valueBtc),
  };
  if (spk.address !== undefined) out.scriptpubkey_address = spk.address;
  return out;
}

// ---- RPC transport -----------------------------------------------------------

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function makeRpc(opts: ShimOptions): RpcFn {
  if (opts.rpc) return opts.rpc;
  const url =
    opts.rpcUrl ??
    env("BITCOIND_RPC_URL") ??
    `http://${opts.rpcHost ?? env("BITCOIND_RPC_HOST") ?? "127.0.0.1"}:${opts.rpcPort ?? env("BITCOIND_RPC_PORT") ?? "18443"}`;
  const cookiePath = opts.cookiePath ?? env("BITCOIND_RPC_COOKIE");
  const user = opts.rpcUser ?? env("BITCOIND_RPC_USER");
  const pass = opts.rpcPassword ?? env("BITCOIND_RPC_PASSWORD");
  if (!cookiePath && !(user && pass)) {
    throw new Error("esplora-shim: need cookiePath or rpcUser+rpcPassword (or BITCOIND_RPC_COOKIE / BITCOIND_RPC_USER+PASSWORD)");
  }
  const auth = (): string => {
    if (cookiePath) {
      // Re-read every call: bitcoind rewrites the cookie on restart.
      return btoa(readFileSync(cookiePath, "utf8").trim());
    }
    return btoa(`${user}:${pass}`);
  };
  let id = 0;
  return async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth()}` },
      body: JSON.stringify({ jsonrpc: "1.0", id: `shim-${++id}`, method, params }),
    });
    const text = await res.text();
    let body: { result?: T; error?: { code: number; message: string } | null };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new RpcError(-32700, `bitcoind returned ${res.status}: ${text.slice(0, 200)}`);
    }
    if (body.error) throw new RpcError(body.error.code, body.error.message);
    if (!res.ok) throw new RpcError(-32603, `bitcoind returned ${res.status}`);
    return body.result as T;
  };
}

// ---- Index ------------------------------------------------------------------

interface IndexedTx {
  tx: EsploraTx; // status kept current
  /** Position within its block (confirmed) or arrival order (mempool). */
  order: number;
  funded: { address: string; value: number }[];
  spent: { address: string; value: number }[];
}

class Index {
  readonly txs = new Map<string, IndexedTx>();
  readonly byAddress = new Map<string, Set<string>>();
  /** height -> hash, only for indexed heights */
  readonly blockHash = new Map<number, string>();
  readonly blockTxids = new Map<number, string[]>();
  indexedTop = -1;
  private mempoolSeq = 0;
  private inFlight: Promise<void> | undefined;
  private headerCache = new Map<number, { hash: string; time: number }>();

  constructor(
    private readonly rpc: RpcFn,
    private readonly startHeight: number,
  ) {
    this.indexedTop = startHeight - 1;
  }

  sync(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.doSync().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async doSync(): Promise<void> {
    const tip = await this.rpc<number>("getblockcount");
    // Reorg check: walk back while our stored hash disagrees with the node.
    while (this.indexedTop >= this.startHeight) {
      const want = await this.rpc<string>("getblockhash", [this.indexedTop]).catch(() => undefined);
      if (want !== undefined && want === this.blockHash.get(this.indexedTop) && this.indexedTop <= tip) break;
      this.unindexBlock(this.indexedTop);
      this.indexedTop--;
    }
    for (let h = this.indexedTop + 1; h <= tip; h++) {
      const hash = await this.rpc<string>("getblockhash", [h]);
      const block = await this.rpc<CoreBlock>("getblock", [hash, 3]);
      await this.indexBlock(block);
      this.indexedTop = h;
    }
    // Mempool: add newcomers, drop what vanished without confirming.
    const mempool = new Set(await this.rpc<string[]>("getrawmempool", [false]));
    for (const [txid, it] of this.txs) {
      if (!it.tx.status.confirmed && !mempool.has(txid)) this.removeTx(txid);
    }
    for (const txid of mempool) {
      if (this.txs.has(txid)) continue;
      const raw = await this.rpc<CoreTx>("getrawtransaction", [txid, 2]).catch(() => undefined);
      if (!raw) continue; // gone between the two calls
      const tx = await this.convert(raw, { confirmed: false });
      this.addTx(tx, ++this.mempoolSeq);
    }
  }

  private async indexBlock(block: CoreBlock): Promise<void> {
    const txids: string[] = [];
    for (let i = 0; i < block.tx.length; i++) {
      const core = block.tx[i]!;
      const status: EsploraStatus = { confirmed: true, block_height: block.height, block_hash: block.hash, block_time: block.time };
      const tx = await this.convert(core, status);
      // If it was in the mempool index, replace it.
      if (this.txs.has(tx.txid)) this.removeTx(tx.txid);
      this.addTx(tx, i);
      txids.push(tx.txid);
    }
    this.blockHash.set(block.height, block.hash);
    this.blockTxids.set(block.height, txids);
    this.headerCache.set(block.height, { hash: block.hash, time: block.time });
  }

  private unindexBlock(height: number): void {
    for (const txid of this.blockTxids.get(height) ?? []) this.removeTx(txid);
    this.blockTxids.delete(height);
    this.blockHash.delete(height);
    this.headerCache.delete(height);
  }

  private addTx(tx: EsploraTx, order: number): void {
    const funded: IndexedTx["funded"] = [];
    const spent: IndexedTx["spent"] = [];
    for (const o of tx.vout) if (o.scriptpubkey_address) funded.push({ address: o.scriptpubkey_address, value: o.value });
    for (const i of tx.vin) if (i.prevout?.scriptpubkey_address) spent.push({ address: i.prevout.scriptpubkey_address, value: i.prevout.value });
    this.txs.set(tx.txid, { tx, order, funded, spent });
    for (const { address } of [...funded, ...spent]) {
      let set = this.byAddress.get(address);
      if (!set) this.byAddress.set(address, (set = new Set()));
      set.add(tx.txid);
    }
  }

  private removeTx(txid: string): void {
    const it = this.txs.get(txid);
    if (!it) return;
    this.txs.delete(txid);
    for (const { address } of [...it.funded, ...it.spent]) {
      const set = this.byAddress.get(address);
      set?.delete(txid);
      if (set && set.size === 0) this.byAddress.delete(address);
    }
  }

  /** Core decoded tx -> Esplora tx. Fills prevouts via txindex when the node did not supply them. */
  async convert(core: CoreTx, status: EsploraStatus): Promise<EsploraTx> {
    const vin: EsploraVin[] = [];
    let inSum = 0;
    let coinbase = false;
    for (const v of core.vin) {
      if (v.coinbase !== undefined) {
        coinbase = true;
        vin.push({
          txid: COINBASE_TXID,
          vout: 0xffffffff,
          prevout: null,
          scriptsig: v.coinbase,
          scriptsig_asm: "",
          witness: v.txinwitness ?? [],
          is_coinbase: true,
          sequence: v.sequence,
        });
        continue;
      }
      let prevout: EsploraVout | null = null;
      if (v.prevout) {
        prevout = coreVoutToEsplora(v.prevout.scriptPubKey, v.prevout.value);
      } else if (v.txid !== undefined && v.vout !== undefined) {
        const known = this.txs.get(v.txid)?.tx.vout[v.vout];
        if (known) prevout = { ...known };
        else {
          const prev = await this.rpc<CoreTx>("getrawtransaction", [v.txid, 1]).catch(() => undefined);
          const o = prev?.vout[v.vout];
          if (o) prevout = coreVoutToEsplora(o.scriptPubKey, o.value);
        }
      }
      if (prevout) inSum += prevout.value;
      vin.push({
        txid: v.txid ?? COINBASE_TXID,
        vout: v.vout ?? 0,
        prevout,
        scriptsig: v.scriptSig?.hex ?? "",
        scriptsig_asm: v.scriptSig?.hex ? scriptToAsm(v.scriptSig.hex) : "",
        witness: v.txinwitness ?? [],
        is_coinbase: false,
        sequence: v.sequence,
      });
    }
    const vout = core.vout.map((o) => coreVoutToEsplora(o.scriptPubKey, o.value));
    const outSum = vout.reduce((n, o) => n + o.value, 0);
    const fee = coinbase ? 0 : core.fee !== undefined ? btcToSats(core.fee) : Math.max(0, inSum - outSum);
    return { txid: core.txid, version: core.version, locktime: core.locktime, vin, vout, size: core.size, weight: core.weight, fee, status };
  }

  async header(height: number): Promise<{ hash: string; time: number }> {
    const cached = this.headerCache.get(height);
    if (cached) return cached;
    const hash = await this.rpc<string>("getblockhash", [height]);
    const hdr = await this.rpc<{ time: number }>("getblockheader", [hash]);
    const h = { hash, time: hdr.time };
    this.headerCache.set(height, h);
    return h;
  }

  txsFor(address: string): IndexedTx[] {
    const ids = this.byAddress.get(address);
    if (!ids) return [];
    return [...ids].map((id) => this.txs.get(id)!);
  }
}

// ---- Query layer ----------------------------------------------------------------

function sortNewestFirst(list: IndexedTx[]): IndexedTx[] {
  return [...list].sort((a, b) => {
    const ha = a.tx.status.confirmed ? a.tx.status.block_height! : Number.POSITIVE_INFINITY;
    const hb = b.tx.status.confirmed ? b.tx.status.block_height! : Number.POSITIVE_INFINITY;
    if (ha !== hb) return hb > ha ? 1 : -1;
    if (a.order !== b.order) return b.order - a.order;
    return a.tx.txid < b.tx.txid ? -1 : 1;
  });
}

export function addressStats(address: string, list: IndexedTx[]): EsploraAddressStats {
  const chain: StatsBucket = { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 };
  const mempool: StatsBucket = { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 };
  for (const it of list) {
    const b = it.tx.status.confirmed ? chain : mempool;
    b.tx_count++;
    for (const f of it.funded) {
      if (f.address !== address) continue;
      b.funded_txo_count++;
      b.funded_txo_sum += f.value;
    }
    for (const s of it.spent) {
      if (s.address !== address) continue;
      b.spent_txo_count++;
      b.spent_txo_sum += s.value;
    }
  }
  return { address, chain_stats: chain, mempool_stats: mempool };
}

class ShimQueries {
  private scanLock: Promise<unknown> = Promise.resolve();
  private validCache = new Map<string, boolean>();

  constructor(
    private readonly rpc: RpcFn,
    readonly index: Index,
    private readonly fixedFeeRate?: number,
  ) {}

  async validateAddress(address: string): Promise<boolean> {
    const cached = this.validCache.get(address);
    if (cached !== undefined) return cached;
    const r = await this.rpc<{ isvalid: boolean }>("validateaddress", [address]);
    this.validCache.set(address, r.isvalid);
    return r.isvalid;
  }

  txsPage(address: string, opts: { mempool: boolean; chain: boolean; afterTxid?: string | undefined; limit?: number | undefined }): EsploraTx[] {
    const all = sortNewestFirst(this.index.txsFor(address));
    const out: EsploraTx[] = [];
    if (opts.mempool) for (const it of all) if (!it.tx.status.confirmed) out.push(it.tx);
    if (opts.chain) {
      let confirmed = all.filter((it) => it.tx.status.confirmed).map((it) => it.tx);
      if (opts.afterTxid !== undefined) {
        const pos = confirmed.findIndex((t) => t.txid === opts.afterTxid);
        confirmed = pos === -1 ? [] : confirmed.slice(pos + 1);
      }
      out.push(...confirmed.slice(0, opts.limit ?? ESPLORA_PAGE));
    }
    return out;
  }

  async utxos(address: string): Promise<EsploraUtxo[]> {
    // scantxoutset refuses to run concurrently; serialise.
    const run = this.scanLock.then(() =>
      this.rpc<{ unspents: { txid: string; vout: number; amount: number; height: number }[] }>("scantxoutset", ["start", [`addr(${address})`]]),
    );
    this.scanLock = run.catch(() => undefined);
    const scan = await run;

    const spentInMempool = new Set<string>();
    const mempoolOuts: EsploraUtxo[] = [];
    for (const it of this.index.txsFor(address)) {
      if (it.tx.status.confirmed) continue;
      for (const v of it.tx.vin) if (v.prevout?.scriptpubkey_address === address) spentInMempool.add(`${v.txid}:${v.vout}`);
      it.tx.vout.forEach((o, n) => {
        if (o.scriptpubkey_address === address) mempoolOuts.push({ txid: it.tx.txid, vout: n, status: { confirmed: false }, value: o.value });
      });
    }
    const out: EsploraUtxo[] = [];
    for (const u of scan.unspents) {
      if (spentInMempool.has(`${u.txid}:${u.vout}`)) continue;
      const hdr = await this.index.header(u.height);
      out.push({
        txid: u.txid,
        vout: u.vout,
        status: { confirmed: true, block_height: u.height, block_hash: hdr.hash, block_time: hdr.time },
        value: btcToSats(u.amount),
      });
    }
    for (const m of mempoolOuts) if (!spentInMempool.has(`${m.txid}:${m.vout}`)) out.push(m);
    return out.sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
  }

  async feeEstimates(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of FEE_TARGETS) {
      if (this.fixedFeeRate !== undefined) {
        out[String(t)] = this.fixedFeeRate;
        continue;
      }
      const r = await this.rpc<{ feerate?: number }>("estimatesmartfee", [Math.min(t, 1008)]).catch(() => ({}) as { feerate?: number });
      // feerate is BTC/kvB; regtest usually has no estimate, so fall back to 1 sat/vB.
      out[String(t)] = r.feerate !== undefined ? Math.max(1, (r.feerate * 1e8) / 1000) : 1;
    }
    return out;
  }

  async recommendedFees(): Promise<Record<string, number>> {
    const est = await this.feeEstimates();
    const pick = (t: number) => est[String(t)] ?? 1;
    return { fastestFee: pick(1), halfHourFee: pick(3), hourFee: pick(6), economyFee: pick(144), minimumFee: pick(1008) };
  }
}

// ---- HTTP -----------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Accept, Content-Type",
};

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { ...CORS, "content-type": contentType, "content-length": Buffer.byteLength(body) });
  res.end(body);
}
const json = (res: ServerResponse, body: unknown) => send(res, 200, JSON.stringify(body), "application/json; charset=utf-8");
const text = (res: ServerResponse, status: number, body: string) => send(res, status, body, "text/plain; charset=utf-8");

export async function start(opts: ShimOptions = {}): Promise<Shim> {
  const rpc = makeRpc(opts);
  const index = new Index(rpc, opts.startHeight ?? 0);
  const q = new ShimQueries(rpc, index, opts.feeRateSatPerVb);
  const log = opts.verbose ? (s: string) => console.error(`[esplora-shim] ${s}`) : () => {};

  // Fail fast if the node is unreachable, and build the initial index.
  await index.sync();

  let requests = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requests++;
    const url = new URL(req.url ?? "/", "http://shim");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    log(`${method} ${url.pathname}`);
    if (method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (method === "POST" && parts.length === 1 && parts[0] === "tx") {
      const hex = (await readBody(req)).trim();
      try {
        const txid = await rpc<string>("sendrawtransaction", [hex]);
        await index.sync();
        text(res, 200, txid);
      } catch (e) {
        if (e instanceof RpcError) {
          // Same body format mempool.space uses (see chain-fixtures/error-responses.json).
          text(res, 400, `sendrawtransaction RPC error: ${JSON.stringify({ code: e.code, message: e.message })}`);
        } else throw e;
      }
      return;
    }
    if (method !== "GET") throw new HttpError(405, "Method not allowed");

    await index.sync();

    if (parts[0] === "blocks" && parts[1] === "tip" && parts[2] === "height" && parts.length === 3) {
      text(res, 200, String(await rpc<number>("getblockcount")));
      return;
    }
    if (parts[0] === "blocks" && parts[1] === "tip" && parts[2] === "hash" && parts.length === 3) {
      text(res, 200, await rpc<string>("getbestblockhash"));
      return;
    }
    if (parts[0] === "fee-estimates" && parts.length === 1) {
      json(res, await q.feeEstimates());
      return;
    }
    if (parts[0] === "v1" && parts[1] === "fees" && parts[2] === "recommended" && parts.length === 3) {
      json(res, await q.recommendedFees());
      return;
    }
    if (parts[0] === "tx" && parts[1]) {
      const it = index.txs.get(parts[1]);
      if (!it) throw new HttpError(404, "Transaction not found");
      if (parts.length === 2) json(res, it.tx);
      else if (parts[2] === "status" && parts.length === 3) json(res, it.tx.status);
      else if (parts[2] === "hex" && parts.length === 3) text(res, 200, await rpc<string>("getrawtransaction", [parts[1], 0]));
      else throw new HttpError(404, "Not found");
      return;
    }
    if (parts[0] === "address" && parts[1]) {
      const address = decodeURIComponent(parts[1]);
      if (!(await q.validateAddress(address))) throw new HttpError(400, "Invalid Bitcoin address");
      const sub = parts.slice(2);
      if (sub.length === 0) {
        json(res, addressStats(address, index.txsFor(address)));
      } else if (sub[0] === "utxo" && sub.length === 1) {
        json(res, await q.utxos(address));
      } else if (sub[0] === "txs" && sub.length === 1) {
        json(res, q.txsPage(address, { mempool: true, chain: true }));
      } else if (sub[0] === "txs" && sub[1] === "chain" && sub.length <= 3) {
        json(res, q.txsPage(address, { mempool: false, chain: true, afterTxid: sub[2] }));
      } else if (sub[0] === "txs" && sub[1] === "mempool" && sub.length === 2) {
        json(res, q.txsPage(address, { mempool: true, chain: false }));
      } else throw new HttpError(404, "Not found");
      return;
    }
    throw new HttpError(404, "Not found");
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) text(res, e.status, e.message);
      else {
        log(`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        text(res, 500, e instanceof Error ? e.message : "Internal error");
      }
    });
  });

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? Number(env("ESPLORA_SHIM_PORT") ?? 0);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const baseUrl = `http://${host}:${actualPort}/`;
  log(`listening on ${baseUrl}`);

  return {
    get requests() {
      return requests;
    },
    baseUrl,
    port: actualPort,
    sync: () => index.sync(),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// Run directly: BITCOIND_RPC_COOKIE=... node --experimental-strip-types test/e2e/esplora-shim.ts
if (typeof process !== "undefined" && process.argv[1]?.endsWith("esplora-shim.ts")) {
  start({ verbose: true })
    .then((s) => console.error(`esplora-shim ready at ${s.baseUrl}`))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
