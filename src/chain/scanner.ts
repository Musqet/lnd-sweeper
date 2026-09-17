/**
 * Address discovery with lnd / btcwallet recovery semantics, in tiers.
 *
 * Recovery rule (btcwallet): on every branch, starting from index 0, look at
 * `window` addresses; whenever one has history the horizon moves to
 * lastUsed + 1 + window; the branch is done when `window` consecutive unused
 * addresses follow the last used one. We reproduce that exactly within
 * whatever window the caller chooses.
 *
 * Tiers (SCAN_TIERS): public Esplora APIs rate-limit, so a 17,500-request
 * scan cannot be the default. The UI calls scan() with window 100 first and,
 * if the user wants, again with 2500 passing the first result as `resumeFrom`.
 * A resume brings every branch up to the new horizon (lastUsed + 1 + window)
 * from where it stopped, so no address is ever looked up twice, and a hit
 * found in a later tier extends only its own branch.
 *
 * Breadth first: within a pass, batches are interleaved across branches (one
 * batch per branch per round) so early results show up on every branch
 * quickly. Result ordering is still deterministic: coin, branch order, index.
 *
 * Branches: the six WALLET_BRANCHES lnd really uses (note m/49' internal is
 * encoded as NATIVE P2WPKH by btcwallet's BIP0049Plus schema; scanning it as
 * nested would miss funds). EXTRA_BRANCHES (49/1 as nested P2WPKH, which lnd
 * never produces but other tooling could have paid to) join in only when
 * window >= extrasFromWindow (default 2500, i.e. tier 2).
 *
 * Coin types: lnd's wallet scopes hardcode coin type 0 on every network, so
 * the primary pass is always coin 0. Off mainnet we run a secondary pass on
 * coin 1 (see walletCoinTypesFor) in case funds ended up there.
 *
 * Cost (SCAN_COST, estimateScanCost, estimateScanSeconds): one GET per address
 * plus one /utxo GET per used address. Empty wallet, mainnet: tier 1 is
 * 6 x 100 = 600 GETs (75 s at the default 8/s); tier 2 adds 6 x 2400 + 2500 =
 * 16,900 (about 35 min). Off mainnet doubles both. The client paces itself and
 * backs off on 429 (see esplora.ts); a self-hosted Esplora removes the limit.
 *
 * Failure: any error mid-scan (network, rate-limit deadline, abort) is
 * rethrown as ScanError carrying `partial`, a ScanResult with everything found
 * so far and per-branch depth at the last completed batch; pass it back as
 * `resumeFrom` to continue exactly there.
 *
 * Key derivation is injected: the scanner only needs something that turns
 * (coinType, branch, index) into a DerivedAddress.
 */
import {
  EXTRA_BRANCHES,
  WALLET_BRANCHES,
  branchKey,
  walletCoinTypesFor,
  type Branch,
  type BranchKey,
  type ChainClient,
  type DerivedAddress,
  type Network,
  type OwnedUtxo,
  type ScanProgress,
  type ScanResult,
} from "../types";
import { DEFAULT_RATE_PER_SECOND, compareUtxo, isAbortError } from "./esplora";

/** lnd's default recovery window (`lncli create` / `--recovery-window`). */
export const DEFAULT_RECOVERY_WINDOW = 2500;
export const DEFAULT_BATCH_SIZE = 50;

export type ScanTier = 100 | 2500;
/** Windows the UI offers, smallest first. */
export const SCAN_TIERS: readonly ScanTier[] = [100, 2500];
export const SCAN_TIER_RATIONALE: Record<ScanTier, string> = {
  100: "Standard wallet gap limit, generous: lnd hands out addresses sequentially, so 100 unused in a row covers even heavy NewAddress use (BIP44 uses 20).",
  2500: "lnd's own recovery window (lncli create --recovery-window default); the exhaustive pass, expensive on public APIs.",
};
/** EXTRA_BRANCHES are scanned only when window >= this. Default: tier 2 only. */
export const DEFAULT_EXTRAS_FROM_WINDOW = 2500;

/** Every branch we know about, in scan (and sort) order: the real ones, then the extras. */
export const ALL_BRANCHES: readonly Branch[] = [...WALLET_BRANCHES, ...EXTRA_BRANCHES];

export type CoinType = 0 | 1;

export type Deriver = (coinType: CoinType, branch: Branch, index: number) => DerivedAddress | Promise<DerivedAddress>;

export interface ScanOptions {
  /** Recovery window (gap of unused addresses that ends a branch). Default 2500; the UI starts with SCAN_TIERS[0]. */
  window?: number;
  /** Addresses looked up per round trip group. Default 50. */
  batchSize?: number;
  /** Branches to scan, in order. Default: WALLET_BRANCHES, plus EXTRA_BRANCHES when window >= extrasFromWindow. */
  branches?: readonly Branch[];
  /** Never scan EXTRA_BRANCHES (only meaningful with the default `branches`). Default false. */
  skipExtras?: boolean;
  /** Include EXTRA_BRANCHES once the window reaches this. Default 2500. */
  extrasFromWindow?: number;
  /** Coin type passes. Default: walletCoinTypesFor(network), primary (0) first. */
  coinTypes?: readonly CoinType[];
  /**
   * Per-branch first index to look up, skipping everything below it. For a
   * wallet whose low indices are known empty (already checked), this avoids
   * re-deriving and re-querying them. The branch is then scanned with the
   * normal gap rule from that index (horizon at least startFrom + window),
   * so a coin at or beyond the start is still found and vein-extended past.
   * Default 0 for every branch. Applies to a fresh scan; ignored where a
   * resumeFrom depth is already further on.
   */
  startFrom?: Partial<Record<BranchKey, number>>;
  /** Called after every batch on every branch. */
  onProgress?: (progress: ScanProgress) => void;
  signal?: AbortSignal;
  /**
   * Continue an earlier result (a smaller tier, or the `partial` of a
   * ScanError). Every branch is brought from its recorded depth up to
   * lastUsed + 1 + window without re-querying anything; findings carry over.
   * With the same window on a complete result this is a no-op.
   */
  resumeFrom?: ScanResult;
}

/** Request and callback counts for a scan step that finds nothing new (the floor; hits add to it). */
export interface ScanCost {
  requests: number;
  progressEvents: number;
}

function branchesFor(opts: { window?: number | undefined; branches?: readonly Branch[] | undefined; skipExtras?: boolean | undefined; extrasFromWindow?: number | undefined }): readonly Branch[] {
  if (opts.branches) return opts.branches;
  const window = opts.window ?? DEFAULT_RECOVERY_WINDOW;
  const withExtras = !opts.skipExtras && window >= (opts.extrasFromWindow ?? DEFAULT_EXTRAS_FROM_WINDOW);
  return withExtras ? ALL_BRANCHES : WALLET_BRANCHES;
}

/**
 * Cost of bringing `resumeFrom` (or nothing) up to `window`, assuming no new
 * hits. Per tier: pass the previous tier's result as `resumeFrom`.
 */
export function estimateScanCost(
  network: Network,
  opts: Pick<ScanOptions, "window" | "batchSize" | "branches" | "skipExtras" | "extrasFromWindow" | "coinTypes" | "resumeFrom" | "startFrom"> = {},
): ScanCost {
  const window = opts.window ?? DEFAULT_RECOVERY_WINDOW;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const branches = branchesFor(opts);
  const coinTypes = opts.coinTypes ?? walletCoinTypesFor(network);
  let requests = 0;
  let progressEvents = 0;
  for (const coinType of coinTypes) {
    const depth = coinType === 0 ? opts.resumeFrom?.depth : opts.resumeFrom?.depthCoin1;
    for (const branch of branches) {
      const key = branchKey(branch);
      const userStart = validStart(opts.startFrom?.[key], key);
      const start = Math.max(depth?.[key] ?? 0, userStart);
      const lastUsed = opts.resumeFrom ? lastUsedIndexIn(opts.resumeFrom.usedAddresses, coinType, branch) : -1;
      const todo = Math.max(0, initialHorizon(window, lastUsed, userStart) - start);
      requests += todo;
      progressEvents += Math.ceil(todo / batchSize);
    }
  }
  return { requests, progressEvents };
}

/** Wall-clock estimate at a request rate (default: the client's default 8/s). */
export function estimateScanSeconds(requests: number, ratePerSecond: number = DEFAULT_RATE_PER_SECOND): number {
  return Math.ceil(requests / ratePerSecond);
}

function tierCosts(network: Network): { window: ScanTier; incremental: ScanCost; cumulative: ScanCost }[] {
  const out: { window: ScanTier; incremental: ScanCost; cumulative: ScanCost }[] = [];
  let prev: ScanResult | undefined;
  let cumulative: ScanCost = { requests: 0, progressEvents: 0 };
  for (const window of SCAN_TIERS) {
    const incremental = estimateScanCost(network, { window, ...(prev ? { resumeFrom: prev } : {}) });
    cumulative = { requests: cumulative.requests + incremental.requests, progressEvents: cumulative.progressEvents + incremental.progressEvents };
    out.push({ window, incremental, cumulative });
    // Pretend the tier completed empty, to cost the next one.
    const depth: Partial<Record<BranchKey, number>> = {};
    for (const b of branchesFor({ window })) depth[branchKey(b)] = window;
    const result: ScanResult = { network, utxos: [], usedAddresses: [], totalSats: 0, depth };
    if (walletCoinTypesFor(network).includes(1)) result.depthCoin1 = { ...depth };
    prev = result;
  }
  return out;
}

/**
 * Empty-wallet cost per tier at the defaults, for the UI and README.
 * mainnet: tier 100 = 600 GETs; tier 2500 adds 16,900 (17,500 total).
 * offMainnet (two coin passes): 1,200 then 33,800 (35,000 total).
 */
export const SCAN_COST = {
  mainnet: tierCosts("mainnet"),
  offMainnet: tierCosts("signet"),
} as const;

/**
 * Thrown by scan() when it cannot finish. `partial` is a valid ScanResult:
 * everything found so far, with `depth` at the last completed batch of every
 * branch, so `scan(..., { resumeFrom: err.partial })` continues exactly there.
 */
export class ScanError extends Error {
  override readonly cause: unknown;
  readonly partial: ScanResult;
  /** True when the underlying cause was an abort (user cancel), not a failure. */
  readonly aborted: boolean;
  constructor(cause: unknown, partial: ScanResult) {
    const aborted = isAbortError(cause);
    super(aborted ? "Scan cancelled" : `Scan failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ScanError";
    this.cause = cause;
    this.partial = partial;
    this.aborted = aborted;
  }
}

/** The branch a derived address belongs to. */
export function branchOf(a: DerivedAddress): Branch {
  return { purpose: a.purpose, change: a.change, kind: a.kind };
}

export function sameBranch(a: Branch, b: Branch): boolean {
  return a.purpose === b.purpose && a.change === b.change && a.kind === b.kind;
}

/** Coin type of a derived address, read from its path m/purpose'/coin'/... */
export function coinTypeOf(a: DerivedAddress): CoinType {
  const m = /^m\/\d+'\/(\d+)'/.exec(a.path);
  if (!m) throw new Error(`Unrecognised derivation path: ${a.path}`);
  return m[1] === "0" ? 0 : 1;
}

function branchRank(b: Branch): number {
  const i = ALL_BRANCHES.findIndex((x) => sameBranch(x, b));
  return i === -1 ? ALL_BRANCHES.length : i;
}

export function compareAddresses(a: DerivedAddress, b: DerivedAddress): number {
  const ca = coinTypeOf(a);
  const cb = coinTypeOf(b);
  if (ca !== cb) return ca - cb;
  const ra = branchRank(branchOf(a));
  const rb = branchRank(branchOf(b));
  if (ra !== rb) return ra - rb;
  return a.index - b.index;
}

export function compareOwnedUtxo(a: OwnedUtxo, b: OwnedUtxo): number {
  return compareAddresses(a.owner, b.owner) || compareUtxo(a, b);
}

function lastUsedIndexIn(addresses: Iterable<DerivedAddress>, coinType: CoinType, branch: Branch): number {
  let last = -1;
  for (const a of addresses) {
    if (a.index > last && sameBranch(branchOf(a), branch) && coinTypeOf(a) === coinType) last = a.index;
  }
  return last;
}

/** Where a branch must have been scanned to for the recovery rule to be satisfied at `window`. */
function completionTarget(window: number, lastUsedIndex: number): number {
  return Math.max(window, lastUsedIndex + 1 + window);
}

/**
 * Initial horizon for a branch. Normally the completion target; when the user
 * starts the branch at a non-zero index (skipping known-empty low indices), the
 * horizon is at least startFrom + window so a full window is scanned from there.
 */
function initialHorizon(window: number, lastUsedIndex: number, userStart: number): number {
  const base = completionTarget(window, lastUsedIndex);
  return userStart > 0 ? Math.max(base, userStart + window) : base;
}

function validStart(value: number | undefined, key: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) throw new Error(`startFrom[${key}] must be a non-negative integer`);
  return value;
}

/**
 * Branches of `result` that the recovery rule says are not finished at
 * `window` (for the UI's "Continue" button). Pass the branches the scan used.
 */
export function incompleteBranches(
  result: ScanResult,
  window = DEFAULT_RECOVERY_WINDOW,
  branches: readonly Branch[] = branchesFor({ window }),
): { coinType: CoinType; branch: Branch }[] {
  const out: { coinType: CoinType; branch: Branch }[] = [];
  const passes: [CoinType, Partial<Record<BranchKey, number>> | undefined][] = [
    [0, result.depth],
    [1, result.depthCoin1],
  ];
  for (const [coinType, depth] of passes) {
    if (!depth) continue;
    for (const branch of branches) {
      const d = depth[branchKey(branch)] ?? 0;
      if (d < completionTarget(window, lastUsedIndexIn(result.usedAddresses, coinType, branch))) out.push({ coinType, branch });
    }
  }
  return out;
}

/** Per-branch scan state. Only completed batches are ever committed here. */
class BranchState {
  used: DerivedAddress[] = [];
  utxos: OwnedUtxo[] = [];
  sats = 0;
  next: number;
  horizon: number;
  lastUsed: number;
  constructor(
    readonly coinType: CoinType,
    readonly branch: Branch,
    readonly key: BranchKey,
    startIndex: number,
    lastUsedIndex: number,
    horizon: number,
  ) {
    this.next = startIndex;
    this.lastUsed = lastUsedIndex;
    this.horizon = horizon;
  }
  get done(): boolean {
    return this.next >= this.horizon;
  }
}

/**
 * Run one batch on a branch: derive, look up stats, fetch utxos for hits,
 * then commit atomically. Throws (without committing) if any lookup fails.
 */
async function step(
  state: BranchState,
  deriver: Deriver,
  client: ChainClient,
  opts: { window: number; batchSize: number; onProgress?: ((p: ScanProgress) => void) | undefined; signal?: AbortSignal | undefined },
): Promise<void> {
  throwIfAborted(opts.signal);
  const { window } = opts;
  const end = Math.min(state.next + opts.batchSize, state.horizon);
  const addrs: DerivedAddress[] = [];
  for (let i = state.next; i < end; i++) addrs.push(await deriver(state.coinType, state.branch, i));

  const stats = await Promise.all(addrs.map((a) => client.getAddressStats(a.address)));
  const hits: DerivedAddress[] = [];
  for (let i = 0; i < addrs.length; i++) {
    const s = stats[i]!;
    if (s.chainTxCount + s.mempoolTxCount > 0) hits.push(addrs[i]!);
  }
  const lists = hits.length > 0 ? await Promise.all(hits.map((a) => client.getAddressUtxos(a.address))) : [];

  for (let i = 0; i < hits.length; i++) {
    const a = hits[i]!;
    state.used.push(a);
    if (a.index > state.lastUsed) state.lastUsed = a.index;
    state.horizon = Math.max(state.horizon, a.index + 1 + window);
    for (const u of lists[i]!) {
      state.utxos.push({ ...u, owner: a });
      state.sats += u.value;
    }
  }
  state.next = end;
  opts.onProgress?.({
    coinType: state.coinType,
    branch: state.branch,
    scanned: state.next,
    window,
    lastUsedIndex: state.lastUsed,
    usedCount: state.used.length,
    utxosFound: state.utxos.length,
    satsFound: state.sats,
  });
}

/** Scan one branch to completion (depth first). Exported for tests; `scan` is the public entry point. */
export async function scanBranch(
  deriver: Deriver,
  client: ChainClient,
  coinType: CoinType,
  branch: Branch,
  opts: {
    window: number;
    batchSize: number;
    startIndex: number;
    lastUsedIndex: number;
    /** Exclusive index the branch must reach at minimum. Default max(startIndex + window, lastUsed + 1 + window). */
    horizon?: number | undefined;
    onProgress?: ((p: ScanProgress) => void) | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<{ used: DerivedAddress[]; utxos: OwnedUtxo[]; depth: number }> {
  const horizon = opts.horizon ?? Math.max(opts.startIndex + opts.window, opts.lastUsedIndex + 1 + opts.window);
  const state = new BranchState(coinType, branch, branchKey(branch), opts.startIndex, opts.lastUsedIndex, horizon);
  while (!state.done) await step(state, deriver, client, opts);
  return { used: state.used, utxos: state.utxos, depth: state.next };
}

/**
 * Scan every requested branch and gather what is spendable.
 * Passes run coin 0 first, then (off mainnet) coin 1. Within a pass, batches
 * are interleaved across branches (round robin) until every branch reaches
 * its horizon. Lookups within a batch run concurrently (bounded by the
 * client's limiter). Results are sorted deterministically: coin, branch
 * order, index. Throws ScanError (with `partial`) if any lookup fails or the
 * signal fires.
 */
export async function scan(
  deriver: Deriver,
  client: ChainClient,
  network: Network,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const window = options.window ?? DEFAULT_RECOVERY_WINDOW;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(window) || window < 1) throw new Error("window must be a positive integer");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive integer");
  const branches = branchesFor({ ...options, window });
  const coinTypes = options.coinTypes ?? walletCoinTypesFor(network);
  const prev = options.resumeFrom;
  if (prev && prev.network !== network) throw new Error("resumeFrom is for a different network");

  const depth0: Partial<Record<BranchKey, number>> = { ...prev?.depth };
  let depth1: Partial<Record<BranchKey, number>> | undefined = prev?.depthCoin1 ? { ...prev.depthCoin1 } : coinTypes.includes(1) ? {} : undefined;
  // Keyed by address, not path: 49/1 as p2wkh and 49/1 as np2wkh share a path but are different addresses.
  const usedByAddress = new Map<string, DerivedAddress>();
  const utxoByKey = new Map<string, OwnedUtxo>();
  for (const a of prev?.usedAddresses ?? []) usedByAddress.set(a.address, a);
  for (const u of prev?.utxos ?? []) utxoByKey.set(`${u.txid}:${u.vout}`, u);

  const assemble = (states: BranchState[]): ScanResult => {
    for (const s of states) {
      for (const a of s.used) usedByAddress.set(a.address, a);
      for (const u of s.utxos) utxoByKey.set(`${u.txid}:${u.vout}`, u);
      (s.coinType === 0 ? depth0 : (depth1 ??= {}))[s.key] = s.next;
    }
    const utxos = [...utxoByKey.values()].sort(compareOwnedUtxo);
    const usedAddresses = [...usedByAddress.values()].sort(compareAddresses);
    const result: ScanResult = { network, utxos, usedAddresses, totalSats: utxos.reduce((n, u) => n + u.value, 0), depth: depth0 };
    if (depth1) result.depthCoin1 = depth1;
    return result;
  };

  const stepOpts = { window, batchSize, onProgress: options.onProgress, signal: options.signal };
  const all: BranchState[] = [];
  for (const coinType of [0, 1] as const) {
    if (!coinTypes.includes(coinType)) continue;
    const depth = coinType === 0 ? depth0 : (depth1 ??= {});
    const states: BranchState[] = [];
    for (const branch of branches) {
      const key = branchKey(branch);
      const userStart = validStart(options.startFrom?.[key], key);
      const startIndex = Math.max(depth[key] ?? 0, userStart);
      const lastUsedIndex = lastUsedIndexIn(usedByAddress.values(), coinType, branch);
      states.push(new BranchState(coinType, branch, key, startIndex, lastUsedIndex, initialHorizon(window, lastUsedIndex, userStart)));
    }
    all.push(...states);
    // Round robin: one batch per unfinished branch per round.
    for (;;) {
      const active = states.filter((s) => !s.done);
      if (active.length === 0) break;
      for (const s of active) {
        try {
          await step(s, deriver, client, stepOpts);
        } catch (cause) {
          throw new ScanError(cause, assemble(all));
        }
      }
    }
  }
  return assemble(all);
}

/** Same as scan() with `resumeFrom: previous`: bring every branch up to `options.window` (a larger tier). */
export function scanDeeper(
  deriver: Deriver,
  client: ChainClient,
  previous: ScanResult,
  options: Omit<ScanOptions, "resumeFrom"> = {},
): Promise<ScanResult> {
  return scan(deriver, client, previous.network, { ...options, resumeFrom: previous });
}

/** Confirmed-only view; the UI decides whether to offer unconfirmed inputs. */
export function confirmedUtxos(result: ScanResult): OwnedUtxo[] {
  return result.utxos.filter((u) => u.status.confirmed);
}

export function unconfirmedUtxos(result: ScanResult): OwnedUtxo[] {
  return result.utxos.filter((u) => !u.status.confirmed);
}

/** Split a result's findings by coin type pass so the UI can label them. */
export function byCoinType(result: ScanResult): Record<CoinType, { utxos: OwnedUtxo[]; usedAddresses: DerivedAddress[]; totalSats: number }> {
  const out = {
    0: { utxos: [] as OwnedUtxo[], usedAddresses: [] as DerivedAddress[], totalSats: 0 },
    1: { utxos: [] as OwnedUtxo[], usedAddresses: [] as DerivedAddress[], totalSats: 0 },
  };
  for (const u of result.utxos) {
    const b = out[coinTypeOf(u.owner)];
    b.utxos.push(u);
    b.totalSats += u.value;
  }
  for (const a of result.usedAddresses) out[coinTypeOf(a)].usedAddresses.push(a);
  return out;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof Error && isAbortError(reason)) throw reason;
    const e = new Error(typeof reason === "string" ? reason : "Scan aborted");
    e.name = "AbortError";
    throw e;
  }
}
