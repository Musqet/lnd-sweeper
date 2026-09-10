/**
 * A ChainClient that spreads requests across several Esplora backends so one
 * server's rate limit does not stall a scan.
 *
 * Two strategies for the per-address lookups a scan makes:
 *   - "spread" (round-robin): each lookup goes to the next healthy backend, so
 *     load is shared evenly and no single server gets hammered. Each server
 *     sees a fraction of the addresses. This is what the trusted-public-servers
 *     option uses.
 *   - "failover": always prefer the earliest-listed server, moving on only when
 *     it 429s. One server sees the addresses in the common case.
 * Either way, a backend that 429s (or errors) is put on a short cooldown and
 * skipped until it recovers; when every backend is cooling we wait for the
 * soonest; only after `deadlineMs` of continuous no-progress do we give up.
 *
 * Fee estimation and broadcast do NOT go through that per-request rotation:
 * they leak nothing about which addresses are yours, so they hit *every*
 * backend at once. Fees take the highest estimate any server returns (never
 * underpay); broadcast returns as soon as any node accepts and propagates to
 * the rest.
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

export type RotateStrategy = "spread" | "failover";

export interface RotatingClientOptions {
  network: Network;
  /** How per-address lookups pick a backend. Default "spread" (round-robin). */
  strategy?: RotateStrategy;
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
  /** How long fee estimation waits for stragglers after the first server answers. Default 1.5 s. */
  feeGraceMs?: number;
  /** Test injection. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
}

export const DEFAULT_ROTATE_DEADLINE_MS = 20 * 60_000;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
export const DEFAULT_ERROR_COOLDOWN_MS = 8_000;
export const DEFAULT_FEE_GRACE_MS = 1_500;
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
  private readonly strategy: RotateStrategy;
  private readonly onStatus: ((s: ClientStatus) => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly deadlineMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly errorCooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly feeGraceMs: number;

  /**
   * Set once the deadline gives up, so every other concurrent lookup on this
   * pool (a scan fans out ~50 at a time) throws the same terminal error on its
   * next loop instead of independently re-arming the stuck clock and hammering
   * dead servers for hours. Cleared by reset() when a scan starts afresh.
   */
  private poisoned: EsploraError | undefined;

  /**
   * When the pool first had every backend cooling with no success since. Set on
   * entering the all-cooling state, cleared on any success, so the deadline
   * measures one *continuous* stuck stretch. It must not be "time since the last
   * ever success": this client is cached in the UI across scans and resumes, so
   * a stale success timestamp would make a resumed scan give up on the first
   * transient blip after a long idle.
   */
  private stuckSince: number | undefined;
  /** True while every backend is cooling, so the next serve announces recovery (clears the UI "slow down" note). */
  private wasAllCooling = false;
  /** Whether any backend has served a request yet (so the first serve is silent). */
  private started = false;
  /** Round-robin cursor for the "spread" strategy. */
  private nextIndex = 0;
  /** Label of the backend last announced, so failover only announces real changes. */
  private lastUsed: string | null = null;
  private lastReason: "rate-limited" | "error" = "rate-limited";

  constructor(urls: readonly string[], opts: RotatingClientOptions) {
    if (urls.length === 0) throw new Error("RotatingChainClient needs at least one server URL");
    this.network = opts.network;
    this.strategy = opts.strategy ?? "spread";
    this.onStatus = opts.onStatus;
    this.signal = opts.signal;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_ROTATE_DEADLINE_MS;
    this.rateLimitCooldownMs = opts.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.errorCooldownMs = opts.errorCooldownMs ?? DEFAULT_ERROR_COOLDOWN_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.feeGraceMs = opts.feeGraceMs ?? DEFAULT_FEE_GRACE_MS;
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

  /**
   * Clear the transient rotation state so a fresh scan starts clean on this
   * cached client: drop any deadline poison, un-cool every backend, reset the
   * round-robin cursor, and forget the throttle/announce state that would
   * otherwise bleed a stale "slow down" or switch event into the next scan.
   */
  reset(): void {
    this.poisoned = undefined;
    this.stuckSince = undefined;
    this.wasAllCooling = false;
    this.started = false;
    this.nextIndex = 0;
    this.lastUsed = null;
    this.lastReason = "rate-limited";
    for (const b of this.backends) b.cooldownUntil = 0;
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

  /**
   * Fee estimation asks every backend at once and takes the highest sat/vB for
   * each confirmation target, so a single throttled server can neither block
   * nor lowball the suggestion. Servers that fail are ignored as long as one
   * answers. (Fee queries reveal nothing about which addresses are yours.)
   */
  async getFeeEstimates(): Promise<Record<string, number>> {
    const merged: Record<string, number> = {};
    let anyOk = false;
    let firstErr: unknown;
    const total = this.backends.length;
    // Resolve as soon as we have an answer plus a short grace for stragglers, so
    // one slow or hung backend cannot hold up the suggestion; a merge across all
    // that did answer takes the highest sat/vB per target.
    await new Promise<void>((resolve) => {
      let settled = 0;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (grace) clearTimeout(grace);
        resolve();
      };
      for (const b of this.backends) {
        b.client.getFeeEstimates().then(
          (v) => {
            // Only merge a well-formed { target: satPerVb } map; ignore junk (null/array/string).
            if (v && typeof v === "object" && !Array.isArray(v)) {
              anyOk = true;
              for (const [k, val] of Object.entries(v)) {
                if (typeof val === "number" && Number.isFinite(val) && val > 0) merged[k] = merged[k] === undefined ? val : Math.max(merged[k]!, val);
              }
            }
            settled += 1;
            if (anyOk && grace === undefined) grace = setTimeout(finish, this.feeGraceMs);
            if (settled === total) finish();
          },
          (e) => {
            firstErr ??= e;
            settled += 1;
            if (isAbortError(e) || this.signal?.aborted || settled === total) finish();
          },
        );
      }
    });
    if (this.signal?.aborted) throw this.signal.reason ?? firstErr ?? new DOMException("Aborted", "AbortError");
    if (!anyOk) throw firstErr ?? new EsploraError("no servers returned fee estimates", this.baseUrl);
    this.noteSuccess();
    return merged;
  }

  /**
   * Broadcast to every backend at once and return as soon as one accepts,
   * propagating to the rest in the background. If all fail, a definitive
   * rejection (a 4xx that is not a 429 — e.g. "bad-txns-inputs-missingorspent",
   * or bad hex) is preferred over a transient one (429, 5xx, network), so the
   * user sees why the transaction is invalid rather than an incidental limit.
   */
  async broadcast(rawTxHex: string): Promise<string> {
    this.throwIfAborted();
    const attempts = this.backends.map((b) => b.client.broadcast(rawTxHex));
    try {
      return await Promise.any(attempts);
    } catch (e) {
      const errors = e instanceof AggregateError ? e.errors : [e];
      for (const err of errors) if (isAbortError(err) || this.signal?.aborted) throw err;
      let definitive: unknown;
      let transient: unknown;
      for (const err of errors) {
        if (isTransientBroadcastError(err)) transient ??= err;
        else definitive ??= err;
      }
      throw definitive ?? transient ?? new EsploraError("no servers available to broadcast", this.baseUrl);
    }
  }

  /**
   * Next backend not cooling. "failover" returns the earliest-listed healthy
   * one; "spread" round-robins from a moving cursor so load shares out. Null
   * when every backend is cooling.
   */
  private pickHealthy(): Backend | null {
    const t = this.now();
    const n = this.backends.length;
    if (this.strategy === "spread") {
      for (let i = 0; i < n; i++) {
        const idx = (this.nextIndex + i) % n;
        const b = this.backends[idx]!;
        if (b.cooldownUntil <= t) {
          this.nextIndex = (idx + 1) % n;
          return b;
        }
      }
      return null;
    }
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
   * Status events for the UI. The one signal both strategies need is the
   * all-cooling recovery: the first serve after every backend was cooling emits
   * a non-cooling "switch" so the UI clears the "slow down" note. In "failover"
   * we additionally announce a genuine change of the preferred server; in
   * "spread" the serving backend changes every request by design, so we stay
   * quiet and let the UI show "across N servers".
   */
  private announce(b: Backend): void {
    if (this.wasAllCooling) {
      this.wasAllCooling = false;
      this.started = true;
      this.lastUsed = b.label;
      this.onStatus?.({ kind: "switch", server: b.label, reason: this.lastReason, allCooling: false, waitMs: 0 });
      return;
    }
    if (this.strategy === "spread") {
      this.started = true;
      this.lastUsed = b.label;
      return;
    }
    if (b.label === this.lastUsed) return;
    const first = !this.started;
    this.started = true;
    this.lastUsed = b.label;
    if (!first) this.onStatus?.({ kind: "switch", server: b.label, reason: this.lastReason, allCooling: false, waitMs: 0 });
  }

  private async run<T>(op: (c: EsploraClient) => Promise<T>): Promise<T> {
    for (;;) {
      // A sibling lookup already hit the deadline: exit with the same error
      // rather than re-arming the stuck clock and hammering dead servers.
      if (this.poisoned) throw this.poisoned;
      this.throwIfAborted();
      const b = this.pickHealthy();
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
        const err = new EsploraError(
          `all ${this.backends.length} chain servers stayed busy or unreachable for ${Math.round(
            since / 60_000,
          )} min with no progress. Point the tool at your own Esplora or mempool server, or try again later.`,
          this.baseUrl,
        );
        this.poisoned = err; // make every sibling lookup stop, not just this one
        throw err;
      }
      const soonest = this.soonest();
      const waitMs = Math.max(0, Math.min(soonest.cooldownUntil - t, this.deadlineMs - since));
      // Announce the throttle once per episode, not once per concurrent lookup.
      if (!this.wasAllCooling) {
        this.wasAllCooling = true;
        this.onStatus?.({ kind: "switch", server: soonest.label, reason: this.lastReason, allCooling: true, waitMs });
      }
      if (waitMs > 0) await this.sleep(waitMs, this.signal);
      else await Promise.resolve();
    }
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) throw this.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}
