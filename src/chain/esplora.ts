/**
 * Esplora HTTP client. Works against mempool.space (mainnet, /signet, /testnet4)
 * and any self-hosted Esplora / electrs instance, plus the regtest shim in test/e2e.
 *
 * Only the endpoints the sweeper needs. No secrets pass through here: an
 * address and a signed transaction are the only things we ever send.
 *
 * Pacing (public APIs rate-limit): requests go through a token bucket of
 * `ratePerSecond` (default 8) with `concurrency` (default 4) in flight. On a
 * 429 we wait Retry-After if given, otherwise 2 s doubling per consecutive
 * 429 (60 s cap), and halve the rate for the next 60 s (halving again on
 * further 429s, floor 0.5/s). 429s never fail a request on their own: we keep
 * retrying until `rateLimitDeadlineMs` (default 20 min) passes with no
 * successful response anywhere on the client, then throw EsploraError 429.
 * `onStatus` reports slow-downs and recoveries so the UI can explain the wait.
 * 5xx and network failures: `maxRetries` with exponential backoff, unchanged.
 * See SCAN_COST / estimateScanSeconds in scanner.ts for what a scan costs.
 */
import { Transaction } from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { AddressStats, AddressTx, ChainClient, Network, TxStatus, Utxo } from "../types";

export interface EsploraClientOptions {
  network: Network;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network failure. Default 3 (so up to 4 attempts). */
  maxRetries?: number;
  /** First backoff delay; doubles each retry. Default 500 ms. */
  backoffBaseMs?: number;
  /** Cap on a single backoff delay. Default 8 s. */
  backoffMaxMs?: number;
  /** Max requests in flight at once. Default 4. */
  concurrency?: number;
  /** Token bucket rate. Default 8 requests per second. */
  ratePerSecond?: number;
  /** Give up on 429s only after this long with no successful response. Default 20 minutes. */
  rateLimitDeadlineMs?: number;
  /** Pacing and retry events, for a "the server asked us to slow down" indicator. */
  onStatus?: (status: ClientStatus) => void;
  /** Aborts every request made through this client. */
  signal?: AbortSignal;
  /** Injection points for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_RATE_PER_SECOND = 8;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_RATE_LIMIT_DEADLINE_MS = 20 * 60_000;
/** How long a 429 keeps the rate halved. */
export const SLOW_DOWN_MS = 60_000;

export type ClientStatus =
  /** The server returned 429; we are waiting `waitMs` and running at `ratePerSecond` for now. */
  | { kind: "slow-down"; waitMs: number; ratePerSecond: number; consecutive429s: number; sinceLastSuccessMs: number }
  /** First successful response after a slow-down; rate is `ratePerSecond` (restored when the halving expires). */
  | { kind: "recovered"; ratePerSecond: number }
  /** Transient failure (5xx, network, our own timeout); retrying after `waitMs`. */
  | { kind: "retry"; status: number | undefined; attempt: number; waitMs: number };

/**
 * Token bucket with a temporary "slow down" mode. Tokens may go negative: a
 * caller reserves its slot and sleeps until it is due, which gives exact
 * spacing under concurrency.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private slowUntil = 0;
  private slowRate: number;
  constructor(
    readonly baseRate: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!(baseRate > 0)) throw new Error("ratePerSecond must be positive");
    this.tokens = baseRate; // allow a one-second burst
    this.last = now();
    this.slowRate = baseRate;
  }
  /** Current effective rate (halved while slowed down). */
  get rate(): number {
    return this.now() < this.slowUntil ? this.slowRate : this.baseRate;
  }
  get slowedDown(): boolean {
    return this.now() < this.slowUntil;
  }
  /** Halve the rate (again) for the next SLOW_DOWN_MS. */
  slowDown(durationMs = SLOW_DOWN_MS): number {
    this.refill(); // settle at the old rate first
    this.slowRate = Math.max(0.5, this.rate / 2);
    this.slowUntil = this.now() + durationMs;
    // Drop any burst allowance so the slower rate applies immediately.
    this.tokens = Math.min(this.tokens, 0);
    return this.slowRate;
  }
  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.baseRate, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }
  /** Milliseconds the caller must wait before its request is due (0 if now). Reserves the token. */
  reserve(): number {
    this.refill();
    this.tokens -= 1;
    if (this.tokens >= 0) return 0;
    const ms = (-this.tokens / this.rate) * 1000;
    return ms < 1 ? 0 : Math.ceil(ms);
  }
}

/** Any non-success response, or a transport failure after retries were exhausted. */
export class EsploraError extends Error {
  readonly url: string;
  readonly status: number | undefined;
  /** Verbatim response body, when there was one. */
  readonly body: string | undefined;
  constructor(message: string, url: string, status?: number, body?: string) {
    super(message);
    this.name = "EsploraError";
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

/** The user-supplied Esplora URL could not be used. `message` is safe to show in the UI. */
export class EsploraUrlError extends Error {
  constructor(
    message: string,
    readonly input: string,
  ) {
    super(message);
    this.name = "EsploraUrlError";
  }
}

/**
 * Accepts what a user is likely to paste: with or without scheme, with or
 * without trailing slash, with or without the "/api" suffix mempool.space uses.
 * Returns an absolute http(s) URL with a host and exactly one trailing slash,
 * or throws EsploraUrlError.
 */
export function normaliseBaseUrl(input: string): string {
  const s = input.trim();
  if (s === "") throw new EsploraUrlError("Esplora URL is empty", input);
  // Anything before "://" is the scheme the user meant; only http and https are acceptable.
  const schemeMatch = /^([^/]*):\/\//.exec(s);
  let withScheme: string;
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    // "ht!tp" or "ht tp" is not a scheme at all; a real but wrong scheme (ftp, ws) gets the specific message.
    if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new EsploraUrlError(`Esplora URL is not valid: ${input}`, input);
    if (scheme !== "http" && scheme !== "https") {
      throw new EsploraUrlError(`Esplora URL must be http or https, not "${schemeMatch[1]}"`, input);
    }
    withScheme = `${scheme}://${s.slice(schemeMatch[0].length)}`;
  } else {
    withScheme = `https://${s}`;
  }
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new EsploraUrlError(`Esplora URL is not valid: ${input}`, input);
  }
  // WHATWG URL is lenient; insist on a plausible host (DNS name, IPv4 or [IPv6]).
  const host = url.hostname;
  const plausibleHost = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?)$/i.test(host);
  if (host === "" || !plausibleHost || url.username !== "" || url.password !== "") {
    throw new EsploraUrlError(`Esplora URL is not valid: ${input}`, input);
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url.toString();
}

/** Simple FIFO concurrency limiter. */
export class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("concurrency must be a positive integer");
  }
  get inFlight(): number {
    return this.active;
  }
  get pending(): number {
    return this.queue.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  e.name = "AbortError";
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/** Combine several optional signals into one (AbortSignal.any is not everywhere yet). */
function anySignal(signals: (AbortSignal | undefined)[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  const listeners: (() => void)[] = [];
  for (const s of live) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    const on = () => controller.abort(s.reason);
    s.addEventListener("abort", on, { once: true });
    listeners.push(() => s.removeEventListener("abort", on));
  }
  return { signal: controller.signal, cleanup: () => listeners.forEach((f) => f()) };
}

interface RawStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}
interface RawUtxo {
  txid: string;
  vout: number;
  value: number;
  status: RawStatus;
}
interface RawAddressStats {
  address: string;
  chain_stats: { funded_txo_count: number; funded_txo_sum: number; spent_txo_count: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_count: number; funded_txo_sum: number; spent_txo_count: number; spent_txo_sum: number; tx_count: number };
}
interface RawVout {
  scriptpubkey: string;
  scriptpubkey_address?: string;
  value: number;
}
interface RawVin {
  txid: string;
  vout: number;
  prevout: RawVout | null;
  is_coinbase: boolean;
}
export interface RawTx {
  txid: string;
  fee: number;
  vin: RawVin[];
  vout: RawVout[];
  status: RawStatus;
}

/** Esplora paginates confirmed history 25 per page (mempool.space serves 50 on the first page). */
export const CHAIN_PAGE_SIZE = 25;

/** Map an Esplora tx JSON to our minimal AddressTx. Exported so the scanner tests can reuse it. */
export function toAddressTx(raw: RawTx): AddressTx {
  return {
    txid: raw.txid,
    status: toStatus(raw.status),
    fee: raw.fee,
    vin: raw.vin.map((v) => {
      const out: AddressTx["vin"][number] = { txid: v.txid, vout: v.vout };
      if (v.prevout) {
        if (v.prevout.scriptpubkey_address !== undefined) out.address = v.prevout.scriptpubkey_address;
        out.value = v.prevout.value;
      }
      return out;
    }),
    vout: raw.vout.map((o) => {
      const out: AddressTx["vout"][number] = { value: o.value, scriptPubKey: o.scriptpubkey };
      if (o.scriptpubkey_address !== undefined) out.address = o.scriptpubkey_address;
      return out;
    }),
  };
}

function toStatus(s: RawStatus): TxStatus {
  const st: TxStatus = { confirmed: s.confirmed };
  if (s.confirmed) {
    if (typeof s.block_height === "number") st.blockHeight = s.block_height;
    if (typeof s.block_time === "number") st.blockTime = s.block_time;
  }
  return st;
}

/** mempool.space recommended-fee buckets, mapped to approximate confirmation targets in blocks. */
const RECOMMENDED_TO_TARGET: Record<string, string> = {
  fastestFee: "1",
  halfHourFee: "3",
  hourFee: "6",
  economyFee: "144",
  minimumFee: "1008",
};

export class EsploraClient implements ChainClient {
  readonly baseUrl: string;
  readonly network: Network;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly rateLimitDeadlineMs: number;
  private readonly onStatus: ((status: ClientStatus) => void) | undefined;
  readonly limiter: Limiter;
  readonly pacer: RateLimiter;
  /** Timestamp of the last successful response, or undefined before the first. */
  private lastSuccessAt: number | undefined;
  private firstRateLimitAt: number | undefined;
  private consecutive429s = 0;

  constructor(baseUrl: string, opts: EsploraClientOptions) {
    this.baseUrl = normaliseBaseUrl(baseUrl);
    this.network = opts.network;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 8_000;
    this.signal = opts.signal;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
    this.rateLimitDeadlineMs = opts.rateLimitDeadlineMs ?? DEFAULT_RATE_LIMIT_DEADLINE_MS;
    this.onStatus = opts.onStatus;
    this.limiter = new Limiter(opts.concurrency ?? DEFAULT_CONCURRENCY);
    this.pacer = new RateLimiter(opts.ratePerSecond ?? DEFAULT_RATE_PER_SECOND, this.now);
  }

  // ---- ChainClient -------------------------------------------------------

  async getTipHeight(): Promise<number> {
    const text = await this.getText("blocks/tip/height");
    const h = Number(text.trim());
    if (!Number.isInteger(h) || h < 0) throw new EsploraError(`Bad tip height: ${text}`, this.url("blocks/tip/height"));
    return h;
  }

  async getAddressStats(address: string): Promise<AddressStats> {
    const raw = await this.getJson<RawAddressStats>(`address/${encodeURIComponent(address)}`);
    if (!raw || typeof raw !== "object" || !raw.chain_stats || !raw.mempool_stats) {
      throw new EsploraError("Unexpected address response", this.url(`address/${address}`));
    }
    return {
      chainTxCount: raw.chain_stats.tx_count,
      mempoolTxCount: raw.mempool_stats.tx_count,
      fundedSats: raw.chain_stats.funded_txo_sum + raw.mempool_stats.funded_txo_sum,
      spentSats: raw.chain_stats.spent_txo_sum + raw.mempool_stats.spent_txo_sum,
    };
  }

  async getAddressUtxos(address: string): Promise<Utxo[]> {
    const raw = await this.getJson<RawUtxo[]>(`address/${encodeURIComponent(address)}/utxo`);
    if (!Array.isArray(raw)) throw new EsploraError("Unexpected utxo response", this.url(`address/${address}/utxo`));
    return raw
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, status: toStatus(u.status) }))
      .sort(compareUtxo);
  }

  /**
   * Every transaction touching the address: mempool ones plus all confirmed
   * pages.
   *
   * Page 1 is /txs: plain Esplora returns all mempool txs plus up to 25
   * confirmed; mempool.space returns up to 50 TOTAL, mempool txs counted
   * inside that cap (observed live: 2 mempool + 48 confirmed). So the number of
   * confirmed txs on page 1 says nothing reliable about whether more exist.
   * Rule: if page 1 is shorter than a chain page (25) it is complete on both
   * backends; otherwise follow /txs/chain/:last_seen_txid from the last
   * confirmed txid, and keep going while a chain page comes back full (25).
   */
  async getAddressTxs(address: string): Promise<AddressTx[]> {
    const enc = encodeURIComponent(address);
    const seen = new Set<string>();
    const out: AddressTx[] = [];
    const absorb = (page: RawTx[]): { added: number; lastConfirmed: string | undefined } => {
      let added = 0;
      let lastConfirmed: string | undefined;
      for (const tx of page) {
        if (tx.status.confirmed) lastConfirmed = tx.txid;
        if (!seen.has(tx.txid)) {
          seen.add(tx.txid);
          out.push(toAddressTx(tx));
          added++;
        }
      }
      return { added, lastConfirmed };
    };

    const first = await this.getJson<RawTx[]>(`address/${enc}/txs`);
    if (!Array.isArray(first)) throw new EsploraError("Unexpected txs response", this.url(`address/${address}/txs`));
    let { lastConfirmed } = absorb(first);
    if (first.length < CHAIN_PAGE_SIZE) return out;

    for (;;) {
      // A full page 1 made of mempool txs alone gives no cursor: /txs/chain without one is the first confirmed page.
      const page = await this.getJson<RawTx[]>(lastConfirmed === undefined ? `address/${enc}/txs/chain` : `address/${enc}/txs/chain/${lastConfirmed}`);
      if (!Array.isArray(page)) throw new EsploraError("Unexpected txs page", this.url(`address/${address}/txs/chain`));
      const r = absorb(page);
      // Stop on a short page, or when a backend ignores the cursor and repeats itself.
      if (page.length < CHAIN_PAGE_SIZE || r.added === 0 || r.lastConfirmed === undefined || r.lastConfirmed === lastConfirmed) break;
      lastConfirmed = r.lastConfirmed;
    }
    return out;
  }

  /**
   * mempool.space: /v1/fees/recommended, mapped onto confirmation targets.
   * Plain Esplora: /fee-estimates (already target -> sat/vB).
   */
  async getFeeEstimates(): Promise<Record<string, number>> {
    let recommended: Record<string, unknown> | undefined;
    try {
      recommended = await this.getJson<Record<string, unknown>>("v1/fees/recommended");
    } catch (e) {
      if (isAbortError(e)) throw e;
      recommended = undefined;
    }
    if (recommended && typeof recommended === "object" && typeof recommended["fastestFee"] === "number") {
      const out: Record<string, number> = {};
      for (const [key, target] of Object.entries(RECOMMENDED_TO_TARGET)) {
        const v = recommended[key];
        if (typeof v === "number" && v > 0) out[target] = v;
      }
      if (Object.keys(out).length > 0) return out;
    }
    const est = await this.getJson<Record<string, unknown>>("fee-estimates");
    if (!est || typeof est !== "object" || Array.isArray(est)) {
      throw new EsploraError("Unexpected fee-estimates response", this.url("fee-estimates"));
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(est)) if (typeof v === "number" && v > 0) out[k] = v;
    return out;
  }

  /**
   * POST /tx with the raw hex. The backend's rejection text is surfaced verbatim.
   *
   * A broadcast can succeed and still look like a failure to us: the response
   * is lost and the retry is rejected ("already known", "missing or spent
   * inputs"), or every attempt errors. So on any failure we compute the txid
   * locally and ask the backend for /tx/:txid; if it has the transaction we
   * report success. We never report failure for a tx the backend already has.
   */
  async broadcast(rawTxHex: string): Promise<string> {
    const hex = rawTxHex.trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new Error("Raw transaction is not valid hex");
    const localTxid = txidOf(hex);
    let text: string;
    try {
      text = await this.request("tx", { method: "POST", body: hex, contentType: "text/plain" });
    } catch (e) {
      if (isAbortError(e) || localTxid === undefined) throw e;
      if (await this.hasTx(localTxid)) return localTxid;
      throw e;
    }
    const txid = text.trim();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new EsploraError(`Unexpected broadcast response: ${text}`, this.url("tx"));
    return txid;
  }

  /** True when the backend knows the transaction (mempool or chain). Network trouble counts as "unknown". */
  async hasTx(txid: string): Promise<boolean> {
    try {
      const status = await this.getJson<{ confirmed?: unknown }>(`tx/${txid}/status`);
      return typeof status === "object" && status !== null && typeof status.confirmed === "boolean";
    } catch (e) {
      if (isAbortError(e)) throw e;
      return false;
    }
  }

  // ---- transport ---------------------------------------------------------

  url(path: string): string {
    return this.baseUrl + path.replace(/^\/+/, "");
  }

  private async getText(path: string): Promise<string> {
    return this.request(path, { method: "GET" });
  }

  private async getJson<T>(path: string): Promise<T> {
    const text = await this.request(path, { method: "GET", accept: "application/json" });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new EsploraError(`Response is not JSON: ${text.slice(0, 200)}`, this.url(path), undefined, text);
    }
  }

  private async request(
    path: string,
    init: { method: "GET" | "POST"; body?: string; contentType?: string; accept?: string },
  ): Promise<string> {
    const url = this.url(path);
    let attempt = 0; // 5xx / network / timeout retries, bounded by maxRetries
    for (;;) {
      this.throwIfAborted();
      const wait = this.pacer.reserve();
      if (wait > 0) await this.sleep(wait, this.signal);
      const result = await this.limiter.run(() => this.attempt(url, init));
      if (result.ok) {
        this.noteSuccess();
        return result.text;
      }
      if (result.status === 429) {
        await this.sleep(this.rateLimited(url, result), this.signal);
        continue;
      }
      const retryable = result.status === undefined || result.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const detail = result.body !== undefined && result.body !== "" ? result.body : result.message;
        throw new EsploraError(
          result.status !== undefined ? `${result.status} from ${url}: ${detail}` : `${url}: ${detail}`,
          url,
          result.status,
          result.body,
        );
      }
      attempt++;
      const waitMs = this.backoffDelay(attempt, result.retryAfterMs);
      this.onStatus?.({ kind: "retry", status: result.status, attempt, waitMs });
      await this.sleep(waitMs, this.signal);
    }
  }

  private noteSuccess(): void {
    this.lastSuccessAt = this.now();
    if (this.consecutive429s > 0) {
      this.consecutive429s = 0;
      this.firstRateLimitAt = undefined;
      this.onStatus?.({ kind: "recovered", ratePerSecond: this.pacer.rate });
    }
  }

  /**
   * 429 policy: never fail on rate limiting alone until the deadline has passed
   * with no successful response anywhere on this client. Returns how long to wait.
   */
  private rateLimited(url: string, result: { body: string | undefined; retryAfterMs: number | undefined }): number {
    const t = this.now();
    this.firstRateLimitAt ??= t;
    this.consecutive429s++;
    const since = t - (this.lastSuccessAt ?? this.firstRateLimitAt);
    if (since >= this.rateLimitDeadlineMs) {
      throw new EsploraError(
        `429 from ${url}: rate limited for ${Math.round(since / 60_000)} min with no progress. Try a self-hosted Esplora or lower the rate.`,
        url,
        429,
        result.body,
      );
    }
    const ratePerSecond = this.pacer.slowDown();
    const remaining = this.rateLimitDeadlineMs - since;
    const exp = Math.min(60_000, 2_000 * 2 ** (this.consecutive429s - 1));
    const waitMs = Math.min(remaining, result.retryAfterMs !== undefined ? Math.min(result.retryAfterMs, 120_000) : exp);
    this.onStatus?.({ kind: "slow-down", waitMs, ratePerSecond, consecutive429s: this.consecutive429s, sinceLastSuccessMs: since });
    return waitMs;
  }

  private async attempt(
    url: string,
    init: { method: "GET" | "POST"; body?: string; contentType?: string; accept?: string },
  ): Promise<
    | { ok: true; text: string }
    | { ok: false; status: number | undefined; body: string | undefined; message: string; retryAfterMs: number | undefined }
  > {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      const e = new Error(`Request timed out after ${this.timeoutMs} ms`);
      e.name = "TimeoutError";
      timeout.abort(e);
    }, this.timeoutMs);
    const { signal, cleanup } = anySignal([this.signal, timeout.signal]);
    try {
      const headers: Record<string, string> = {};
      if (init.accept) headers["Accept"] = init.accept;
      if (init.body !== undefined) headers["Content-Type"] = init.contentType ?? "text/plain";
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: init.method, headers, signal, ...(init.body !== undefined ? { body: init.body } : {}) });
      } catch (e) {
        // User abort is final. Our own timeout and network errors are retryable.
        if (this.signal?.aborted) throw abortError(this.signal);
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, status: undefined, body: undefined, message, retryAfterMs: undefined };
      }
      const text = await res.text();
      if (res.ok) return { ok: true, text };
      const ra = res.headers.get("retry-after");
      const retryAfterMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
      return { ok: false, status: res.status, body: text, message: res.statusText || `HTTP ${res.status}`, retryAfterMs };
    } finally {
      clearTimeout(timer);
      cleanup();
    }
  }

  /** 5xx / network backoff. Honours Retry-After but never waits more than 30 s on a single hop. */
  private backoffDelay(attempt: number, retryAfterMs: number | undefined): number {
    const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * Math.min(250, exp / 4));
    return Math.max(exp + jitter, Math.min(retryAfterMs ?? 0, 30_000));
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) throw abortError(this.signal);
  }
}

export function compareUtxo(a: Utxo, b: Utxo): number {
  return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout;
}

/**
 * txid of a raw transaction (witness-stripped double SHA256, displayed
 * reversed), or undefined when the hex does not parse as a transaction.
 */
export function txidOf(rawTxHex: string): string | undefined {
  try {
    return Transaction.fromRaw(hexToBytes(rawTxHex.trim()), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
      disableScriptCheck: true,
    }).id;
  } catch {
    return undefined;
  }
}
