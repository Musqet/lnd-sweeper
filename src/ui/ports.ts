/**
 * What the UI needs from the rest of the app, expressed in terms of src/types.ts.
 *
 * The UI programs against this interface only. `src/ui/adapters.ts` binds it to
 * the real modules (aezeed, keys, chain, tx, address); `src/ui/mock.ts` provides
 * an in-memory implementation for development and screenshots.
 */
import type {
  AddressTx,
  Branch,
  ChainClient,
  CipherSeed,
  DerivedAddress,
  Network,
  OwnedUtxo,
  ScanProgress,
  ScanResult,
  SignedSweep,
  SweepPlan,
} from "../types";

export interface WordCheck {
  /** True when the word is in the aezeed (BIP39 English) list. */
  valid: boolean;
  /** Close matches for an invalid word, best first. Empty when valid. */
  suggestions: string[];
}

export type UiErrorCode =
  | "passphrase" // wrong cipher seed passphrase
  | "checksum" // words do not decipher
  | "words" // wrong count or unknown word
  | "fee-too-large" // fee above the sanity fraction; user may accept
  | "dust" // output below dust after fee, or fee larger than the total
  | "unconfirmed" // an input is unconfirmed and that was not allowed
  | "plan-tampered" // the plan handed to the signer is not the one planSweep produced
  | "network" // chain data source unreachable or answered badly
  | "other";

/** Error with a code the UI can branch on. The message is always fit to show. */
export class UiError extends Error {
  constructor(
    message: string,
    readonly code: UiErrorCode = "other",
    /** Verbatim backend text when there is one, for the small grey line under the plain explanation. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "UiError";
  }
}

/** scan() could not finish. `partial` is a valid result to show and to resume from. */
export class ScanFailure extends UiError {
  constructor(
    message: string,
    readonly partial: ScanResult,
    readonly aborted: boolean,
    detail?: string,
  ) {
    super(message, aborted ? "other" : "network", detail);
    this.name = "ScanFailure";
  }
}

export type DestinationCheck =
  | { ok: true; kind: string; network: Network }
  | { ok: false; reason: string };

/** Live pacing information from the chain client. `throttled` means the server asked us to slow down and we are pacing. */
export interface ScanStatus {
  throttled: boolean;
  /** Lookups a second we are running at now, when known. */
  ratePerSecond?: number;
  /** Host of the backend now serving requests, when using more than one. */
  server?: string;
}

export interface ScanRequest {
  seed: CipherSeed;
  network: Network;
  client: ChainClient;
  /** Recovery window: a branch is done once this many unused addresses follow the last used one. */
  window: number;
  /** Continue an earlier result: unfinished branches are finished, and a larger `window` extends every branch. */
  resumeFrom?: ScanResult | undefined;
  /** Restrict the scan to these branches (a per-path deepen). Default: all wallet branches. */
  branches?: readonly Branch[] | undefined;
  /** Restrict the scan to these coin type passes. Default: the network's usual passes. */
  coinTypes?: readonly (0 | 1)[] | undefined;
  onProgress: (p: ScanProgress) => void;
  signal?: AbortSignal | undefined;
}

export interface PlanOptions {
  /** Chain tip, used as nLockTime. */
  tipHeight?: number | undefined;
  /** Accept a fee above the sanity fraction of the total. */
  allowHighFee?: boolean | undefined;
  /** Spend outputs that are not yet confirmed. Only after the user has acknowledged the warning. */
  allowUnconfirmed?: boolean | undefined;
}

export type TxView = AddressTx & { netSats?: number };

export interface Ports {
  /** Check one seed word. Case-insensitive; caller trims. */
  checkWord(word: string): WordCheck;
  /** Decipher the 24 words. Slow (scrypt); must not block the event loop for long. Throws UiError. */
  decipher(words: string[], passphrase: string): Promise<CipherSeed>;
  /**
   * Build the chain client. One URL is used directly; several are rotated across
   * (failover) so a single server's rate limit does not stall a scan.
   * `onStatus` receives pacing and rotation events for the life of the client.
   */
  createChainClient(sources: string | string[], network: Network, onStatus?: (s: ScanStatus) => void): ChainClient;
  /** Throws ScanFailure (with partial results) when it cannot finish. */
  scan(req: ScanRequest): Promise<ScanResult>;
  /** Branches that have not yet reached the recovery window past their last used address. Pass `branches` to scope the check to a single path. */
  incompleteBranches(result: ScanResult, window: number, branches?: readonly Branch[]): { coinType: 0 | 1; branch: Branch }[];
  /** Lookups and rough seconds a scan to `window` needs; with `resumeFrom`, only the extra work beyond that result. `opts.branches`/`opts.coinTypes` scope it to a single path. */
  scanCost(network: Network, window: number, resumeFrom?: ScanResult, opts?: { branches?: readonly Branch[]; coinTypes?: readonly (0 | 1)[] }): { requests: number; seconds: number };
  /** Transactions touching these addresses, newest first, de-duplicated. */
  fetchTransactions(client: ChainClient, addresses: readonly DerivedAddress[], signal?: AbortSignal): Promise<TxView[]>;
  validateDestination(address: string, network: Network): DestinationCheck;
  /** Throws UiError with code "dust" or "fee-too-large" where relevant. */
  planSweep(inputs: OwnedUtxo[], destination: string, feeRateSatPerVb: number, network: Network, opts?: PlanOptions): SweepPlan;
  signSweep(plan: SweepPlan, seed: CipherSeed, network: Network): Promise<SignedSweep>;
}

/** Coin type of a derived address, read from its path m/purpose'/coin'/... */
export function coinTypeOfPath(path: string): 0 | 1 {
  const m = /^m\/\d+'\/(\d+)'/.exec(path);
  return m && m[1] === "0" ? 0 : 1;
}
