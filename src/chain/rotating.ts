/**
 * A ChainClient that spreads requests across several Esplora backends so one
 * server's rate limit does not stall a scan.
 *
 * Behaviour is failover, not round-robin: it always prefers the earliest-listed
 * reachable server, so in the common case a single server sees your addresses
 * (best for privacy). The instant that server returns 429 (or a network/5xx
 * error), it is put on a short cooldown and the next server takes over with no
 * wait. When its cooldown expires it becomes preferred again. Only when *every*
 * backend is cooling do we wait, for the soonest to recover; only after
 * `deadlineMs` with no successful response on any backend do we give up.
 *
 * Each backend is a normal EsploraClient configured to fail fast (it throws on
 * the first 429 instead of waiting), because rotating to a fresh server beats
 * waiting on a limited one. This wrapper owns the patience the single client
 * used to have.
 *
 * A single-URL source (someone's own node) does NOT use this: it stays a plain
 * EsploraClient so nothing ever leaks to a public server behind their back.
 */
import type { AddressStats, AddressTx, ChainClient, Network, Utxo } from "../types";
import {
  type ClientStatus,
  EsploraClient,
  type EsploraClientOptions,
  EsploraError,
  isAbortError,
} from "./esplora";
import { serverLabel } from "./servers";

export interface RotatingClientOptions {
  network: Network;
  /** Rotation and (aggregate) pacing events. */
  onStatus?: (s: ClientStatus) => void;
  signal?: AbortSignal;
  /** Give up only after this long with no successful response on ANY backend. Default 20 min. */
  deadlineMs?: number;
  /** Cooldown after a 429 with no Retry-After. Default 30 s; a Retry-After is honoured up to 120 s. */
  rateLimitCooldownMs?: number;
  /** Cooldown after a network/5xx failure. Default 8 s. */
  errorCooldownMs?: number;
  /** Options passed to each backend EsploraClient (rate, concurrency, timeouts). */
  backend?: Partial<EsploraClientOptions>;
  /** Test injection. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
}

export const DEFAULT_ROTATE_DEADLINE_MS = 20 * 60_000;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
export const DEFAULT_ERROR_COOLDOWN_MS = 8_000;
const MAX_COOLDOWN_MS = 120_000;

interface Backend {
  readonly client: EsploraClient;
  readonly label: string;
  /** now()-clock timestamp before which this backend is skipped. */
  cooldownUntil: number;
}

/** A broadcast failure worth stepping past: rate limit, server error, or network trouble. A 4xx rejection (not 429) is the node's verdict on the transaction and is kept. */
function isTransientBroadcastError(e: unknown): boolean {
  if (!(e instanceof EsploraError)) return false; // e.g. bad-hex Error: definitive
  return e.status === undefined || e.status === 429 || e.status >= 500;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class RotatingChainClient implements ChainClient {
  readonly baseUrl: string;
  readonly network: Network;
  private readonly backends: Backend[];
  private readonly onStatus: ((s: ClientStatus) => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly deadlineMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly errorCooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  /**
   * When the pool first had every backend cooling with no success since. Set on
   * entering the all-cooling state, cleared on any success, so the deadline
   * measures one *continuous* stuck stretch. It must not be "time since the last
   * ever success": this client is cached in the UI across scans and resumes, so
   * a stale success timestamp would make a resumed scan give up on the first
   * transient blip after a long idle.
   */
  private stuckSince: number | undefined;
  /** Whether any backend has served a request yet (so the first serve is silent). */
  private started = false;
  /** Label of the backend last handed a request, so we only announce real switches. */
  private lastUsed: string | null = null;
  private lastReason: "rate-limited" | "error" = "rate-limited";

  constructor(urls: readonly string[], opts: RotatingClientOptions) {
    if (urls.length === 0) throw new Error("RotatingChainClient needs at least one server URL");
    this.network = opts.network;
    this.onStatus = opts.onStatus;
    this.signal = opts.signal;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_ROTATE_DEADLINE_MS;
    this.rateLimitCooldownMs = opts.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.errorCooldownMs = opts.errorCooldownMs ?? DEFAULT_ERROR_COOLDOWN_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.backends = urls.map((url) => {
      const client = new EsploraClient(url, {
        network: opts.network,
        ...opts.backend,
        // Fail fast so a 429 rotates us rather than waiting: the pool owns patience.
        rateLimitDeadlineMs: 0,
        maxRetries: opts.backend?.maxRetries ?? 1,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      return { client, label: serverLabel(client.baseUrl), cooldownUntil: 0 };
    });
    this.baseUrl = this.backends[0]!.client.baseUrl;
  }

  /** All backend base URLs, in preference order. */
  get servers(): string[] {
    return this.backends.map((b) => b.client.baseUrl);
  }

  getTipHeight(): Promise<number> {
    return this.run((c) => c.getTipHeight());
  }
  getAddressStats(address: string): Promise<AddressStats> {
    return this.run((c) => c.getAddressStats(address));
  }
  getAddressUtxos(address: string): Promise<Utxo[]> {
    return this.run((c) => c.getAddressUtxos(address));
  }
  getAddressTxs(address: string): Promise<AddressTx[]> {
    return this.run((c) => c.getAddressTxs(address));
  }
  getFeeEstimates(): Promise<Record<string, number>> {
    return this.run((c) => c.getFeeEstimates());
  }

  /**
   * Broadcast is a single pass over every backend: the first to accept wins
   * (propagation to more nodes is a bonus). If all fail, a definitive rejection
   * (a 4xx that is not a 429 — e.g. "bad-txns-inputs-missingorspent", or bad
   * hex) is preferred over a transient one (429, 5xx, network), so the user
   * sees why the transaction is invalid rather than an incidental rate limit.
   */
  async broadcast(rawTxHex: string): Promise<string> {
    let definitive: unknown;
    let transient: unknown;
    for (const b of this.backends) {
      this.throwIfAborted();
      try {
        return await b.client.broadcast(rawTxHex);
      } catch (e) {
        if (isAbortError(e) || this.signal?.aborted) throw e;
        if (isTransientBroadcastError(e)) transient ??= e;
        else definitive ??= e;
      }
    }
    throw definitive ?? transient ?? new EsploraError("no servers available to broadcast", this.baseUrl);
  }

  /** The earliest-listed backend not currently cooling, or null if all are. */
  private firstHealthy(): Backend | null {
    const t = this.now();
    for (const b of this.backends) if (b.cooldownUntil <= t) return b;
    return null;
  }

  private soonest(): Backend {
    let best = this.backends[0]!;
    for (const b of this.backends) if (b.cooldownUntil < best.cooldownUntil) best = b;
    return best;
  }

  private noteSuccess(): void {
    this.stuckSince = undefined;
  }

  /**
   * Tell the UI which backend is now serving, but only when it actually changed
   * and never for the very first request (the UI already shows the starting
   * server). After an all-cooling wait `lastUsed` is reset to null so the
   * recovering backend re-announces, which is what clears the "slow down" note.
   */
  private announce(b: Backend): void {
    if (b.label === this.lastUsed) return;
    const first = !this.started;
    this.started = true;
    this.lastUsed = b.label;
    if (!first) this.onStatus?.({ kind: "switch", server: b.label, reason: this.lastReason, allCooling: false, waitMs: 0 });
  }

  private async run<T>(op: (c: EsploraClient) => Promise<T>): Promise<T> {
    for (;;) {
      this.throwIfAborted();
      const b = this.firstHealthy();
      if (b) {
        this.announce(b);
        try {
          const r = await op(b.client);
          this.noteSuccess();
          return r;
        } catch (e) {
          if (isAbortError(e) || this.signal?.aborted) throw e;
          const is429 = e instanceof EsploraError && e.status === 429;
          this.lastReason = is429 ? "rate-limited" : "error";
          const cooldown = is429
            ? Math.min(MAX_COOLDOWN_MS, Math.max(1_000, (e as EsploraError).retryAfterMs ?? this.rateLimitCooldownMs))
            : this.errorCooldownMs;
          b.cooldownUntil = this.now() + cooldown;
          continue;
        }
      }
      // Every backend is cooling. Start (or continue) the stuck clock and give
      // up only after a continuous deadline with no success anywhere. The message
      // deliberately avoids "429"/"rate limit" so the UI treats it as a hard stop
      // (manual retry) rather than the auto-continue it uses for a mid-scan 429.
      const t = this.now();
      this.stuckSince ??= t;
      const since = t - this.stuckSince;
      if (since >= this.deadlineMs) {
        this.stuckSince = undefined;
        throw new EsploraError(
          `all ${this.backends.length} chain servers stayed busy or unreachable for ${Math.round(
            since / 60_000,
          )} min with no progress. Point the tool at your own Esplora or mempool server, or try again later.`,
          this.baseUrl,
        );
      }
      const soonest = this.soonest();
      const waitMs = Math.max(0, Math.min(soonest.cooldownUntil - t, this.deadlineMs - since));
      this.onStatus?.({ kind: "switch", server: soonest.label, reason: this.lastReason, allCooling: true, waitMs });
      // Force the next healthy pick to announce itself.
      this.lastUsed = null;
      if (waitMs > 0) await this.sleep(waitMs, this.signal);
      else await Promise.resolve();
    }
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) throw this.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}
