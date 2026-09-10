/**
 * All in-memory state for one session. Nothing is persisted anywhere.
 * `reset()` zero-fills key material and drops every reference.
 */
import type { ChainClient, CipherSeed, Network, ScanResult, SignedSweep, SweepPlan } from "../types";
import type { ScanStatus } from "./ports";

export type StepId = "start" | "seed" | "scan" | "sweep" | "result";
export const STEPS: { id: StepId; label: string }[] = [
  { id: "start", label: "Start" },
  { id: "seed", label: "Seed" },
  { id: "scan", label: "Scan" },
  { id: "sweep", label: "Sweep" },
  { id: "result", label: "Done" },
];

export interface AppState {
  step: StepId;
  network: Network;
  /**
   * When true, the scan spreads across the trusted public servers for the
   * network (failover). When false, only `sourceUrl` is used. Forced false on
   * regtest, which has no public servers.
   */
  useTrustedServers: boolean;
  /** The custom server URL (used when useTrustedServers is false) and the explorer-link base. */
  sourceUrl: string;
  words: string[];
  passphrase: string;
  seed: CipherSeed | null;
  client: ChainClient | null;
  /** Where the chain client's pacing events go; the scan step points this at its status line while mounted. */
  chainStatus: ((s: ScanStatus) => void) | null;
  scan: ScanResult | null;
  /** The user ticked the box accepting unconfirmed outputs in the sweep. */
  includeUnconfirmed: boolean;
  /** Set on the fresh state after "start over" so the first screen can say what was wiped. */
  justCleared: boolean;
  /** Recovery window the current result was scanned to (per-branch depth lives in scan.depth). */
  scanWindow: number;
  feeEstimates: Record<string, number> | null;
  /** Destination as typed, so leaving and returning to the sweep step keeps it. */
  destination: string;
  plan: SweepPlan | null;
  signed: SignedSweep | null;
  broadcastTxid: string | null;
}

/** lnd's full recovery window. */
export const DEFAULT_WINDOW = 2500;
/** Gap limits: the standard-wallet default first, then lnd's own recovery window. */
export const SCAN_TIERS: readonly number[] = [100, 2500];

export function freshState(): AppState {
  return {
    step: "start",
    network: "mainnet",
    useTrustedServers: true,
    sourceUrl: "https://mempool.space/api",
    words: Array.from({ length: 24 }, () => ""),
    passphrase: "",
    seed: null,
    client: null,
    chainStatus: null,
    scan: null,
    includeUnconfirmed: false,
    justCleared: false,
    scanWindow: SCAN_TIERS[0]!,
    feeEstimates: null,
    destination: "",
    plan: null,
    signed: null,
    broadcastTxid: null,
  };
}

/** Best-effort wipe of secret material before dropping references. */
export function wipe(state: AppState): void {
  if (state.seed) {
    state.seed.entropy.fill(0);
    state.seed.salt.fill(0);
  }
  state.words.fill("");
  state.passphrase = "";
  state.seed = null;
  state.plan = null;
  state.destination = "";
  state.signed = null;
  state.scan = null;
  state.includeUnconfirmed = false;
  state.client = null;
  state.chainStatus = null;
  state.feeEstimates = null;
  state.broadcastTxid = null;
}
