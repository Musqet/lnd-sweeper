/**
 * Build an unsigned sweep plan: every owned UTXO into one output, minus the fee.
 * Nothing here touches private keys. The plan is what the user reviews before signing.
 *
 * Tamper evidence and its threat model
 * ------------------------------------
 * A plan returned here is the only thing signSweep will sign. Three mechanisms enforce that:
 *  1. Identity: the returned object is recorded in a module-private WeakSet; signSweep refuses
 *     any other object, including spreads, structuredClone, Proxies and JSON round trips.
 *  2. Immutability: the plan, its inputs array, every input, status and owner are deep copies
 *     owned by this module and frozen, so fields cannot be reassigned and accessors cannot be
 *     installed. Typed array contents cannot be frozen, so signSweep reads every field exactly
 *     once into a private snapshot (copying the bytes) and works only from that snapshot.
 *  3. Integrity: `commitment` is HMAC-SHA256 over every field that decides what gets signed,
 *     including each owner's script and key, keyed with 32 random bytes generated once per module
 *     load and held in a closure. Neither the key nor the function that computes the commitment is
 *     exported, so no code outside this module can produce a commitment for fields of its
 *     choosing; signSweep recomputes it over the snapshot and compares.
 * What this defends: accidental mutation between review and signing, copies of a plan, plans
 * built outside planSweep, and in-place edits or accessor tricks on a returned plan. Byte copies
 * are made with constructors captured at module load and an index loop, never with .from, .slice
 * or .set on caller-supplied objects, so a later replacement of Uint8Array.from cannot slip a
 * stateful proxy into the snapshot. What it does not defend: code that can call planSweep itself
 * and show the user something other than what it passed, and replacement of JavaScript built-ins
 * after this module has loaded beyond the constructors and functions captured below. That
 * boundary is held by the single-file build, its content hash and the Content Security Policy,
 * not by this module.
 */
import * as btc from "@scure/btc-signer";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { DUST_SATS, validateDestination, type DestinationKind } from "../address";
import type { AddressKind, DerivedAddress, Network, OwnedUtxo, SweepPlan, TxStatus } from "../types";
import { estimateSweepVsize, feeForVsize } from "./estimate";

// Built-ins captured at module load. Everything below uses these, never the live globals.
const U8 = Uint8Array;
const freeze = Object.freeze;
const isArray = Array.isArray;

/** Copies bytes by reading each index once into a fresh, module-owned Uint8Array. */
export function copyBytes(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new U8(n);
  for (let i = 0; i < n; i++) out[i] = src[i]!;
  return out;
}

export type SweepErrorCode =
  | "no-inputs"
  | "bad-input"
  | "duplicate-input"
  | "mixed-networks"
  | "bad-destination"
  | "fee-rate-too-low"
  | "fee-rate-too-high"
  | "fee-too-large"
  | "fee-exceeds-total"
  | "dust"
  | "unconfirmed-input"
  | "bad-plan"
  | "plan-tampered"
  | "key-mismatch"
  | "verify-failed";

export class SweepError extends Error {
  readonly code: SweepErrorCode;
  constructor(code: SweepErrorCode, message: string) {
    super(message);
    this.name = "SweepError";
    this.code = code;
  }
}

export interface SweepOptions {
  /** Current chain tip height. Used as nLockTime so the sweep cannot be mined into an earlier block (anti fee-sniping). */
  tipHeight?: number;
  /** Sanity cap on the fee rate. Default 500 sat/vB. */
  maxFeeRateSatPerVb?: number;
  /** Largest share of the total the fee may take without allowHighFee. Default 0.2. */
  maxFeeFraction?: number;
  /** Explicitly accept a fee above maxFeeFraction of the total. */
  allowHighFee?: boolean;
  /** Explicitly accept inputs that are not yet confirmed in a block. Default false. */
  allowUnconfirmed?: boolean;
}

export const DEFAULT_MAX_FEE_RATE = 500;
export const DEFAULT_MAX_FEE_FRACTION = 0.2;
export const MIN_FEE_RATE = 1;
/** nSequence signalling opt-in replace-by-fee (BIP125) while still enabling nLockTime. */
export const RBF_SEQUENCE = 0xfffffffd;

/**
 * A SweepPlan with the extra fields the signer needs. Satisfies the shared SweepPlan contract.
 * `commitment` is a hash over every field that affects where the money goes; signSweep recomputes
 * it and refuses to sign if anything changed after the user reviewed the plan.
 */
export interface PreparedSweep extends SweepPlan {
  network: Network;
  destinationKind: DestinationKind;
  destinationScript: Uint8Array;
  lockTime: number;
  sequence: number;
  version: 2;
  /** Hex sha256, see computeCommitment. */
  commitment: string;
}

/** Fields covered by the plan commitment. */
type CommittedFields = Omit<PreparedSweep, "commitment" | "estimatedVsize">;

// Module-private state. Nothing in this block is exported, directly or via index.ts.
const { commit, matches, register, isRegistered } = (() => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const registry = new WeakSet<object>();
  /**
   * HMAC-SHA256 over a canonical rendering of everything that decides what gets signed:
   * network, every input (txid:vout:value, in plan order), destination string, kind and script,
   * fee rate, fee, output amount, lockTime, sequence and version.
   */
  const commit = (plan: CommittedFields): string => {
    const parts = [
      "lnd-sweeper-plan-v2",
      plan.network,
      plan.inputs
        .map((u) => `${u.txid}:${u.vout}:${u.value}:${u.owner.kind}:${u.owner.address}:${bytesToHex(u.owner.publicKey)}:${bytesToHex(u.owner.scriptPubKey)}`)
        .join(","),
      plan.destination,
      plan.destinationKind,
      bytesToHex(plan.destinationScript),
      String(plan.feeRateSatPerVb),
      String(plan.feeSats),
      String(plan.outputSats),
      String(plan.lockTime),
      String(plan.sequence),
      String(plan.version),
    ];
    return bytesToHex(hmac(sha256, key, utf8ToBytes(parts.join("|"))));
  };
  const matches = (plan: PreparedSweep): boolean => {
    const expected = commit(plan);
    if (expected.length !== plan.commitment.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ plan.commitment.charCodeAt(i);
    return diff === 0;
  };
  return {
    commit,
    matches,
    register: (plan: PreparedSweep) => {
      registry.add(plan);
      return plan;
    },
    isRegistered: (plan: object) => registry.has(plan),
  };
})();

/**
 * True if `original` is the very object planSweep returned and `snapshot` (a copy of its fields,
 * each read exactly once) carries a matching commitment. Check only; cannot forge.
 */
export function isGenuinePlan(original: object, snapshot: PreparedSweep): boolean {
  return isRegistered(original) && matches(snapshot);
}

function copyOwner(o: DerivedAddress): DerivedAddress {
  return {
    kind: o.kind,
    purpose: o.purpose,
    network: o.network,
    path: o.path,
    change: o.change,
    index: o.index,
    address: o.address,
    publicKey: copyBytes(o.publicKey),
    scriptPubKey: copyBytes(o.scriptPubKey),
  };
}

function copyStatus(st: TxStatus): TxStatus {
  return {
    confirmed: st.confirmed,
    ...(st.blockHeight !== undefined ? { blockHeight: st.blockHeight } : {}),
    ...(st.blockTime !== undefined ? { blockTime: st.blockTime } : {}),
  };
}

function copyInput(u: OwnedUtxo): OwnedUtxo {
  return { txid: u.txid, vout: u.vout, value: u.value, status: copyStatus(u.status), owner: copyOwner(u.owner) };
}

/**
 * Deep copy of a prepared plan, reading every field exactly once. signSweep works only from this,
 * so a getter that answers differently on later reads has nothing to act on.
 */
export function snapshotPlan(p: PreparedSweep): PreparedSweep {
  return {
    inputs: p.inputs.map(copyInput),
    destination: p.destination,
    feeRateSatPerVb: p.feeRateSatPerVb,
    estimatedVsize: p.estimatedVsize,
    feeSats: p.feeSats,
    outputSats: p.outputSats,
    network: p.network,
    destinationKind: p.destinationKind,
    destinationScript: copyBytes(p.destinationScript),
    lockTime: p.lockTime,
    sequence: p.sequence,
    version: p.version,
    commitment: p.commitment,
  };
}

function deepFreezePlan(p: PreparedSweep): PreparedSweep {
  for (const u of p.inputs) {
    freeze(u.owner);
    freeze(u.status);
    freeze(u);
  }
  freeze(p.inputs);
  return freeze(p);
}

/** Output script that a public key of this lnd wallet kind pays to. Throws on an invalid key. */
export function scriptForOwnerKey(kind: AddressKind, publicKey: Uint8Array): Uint8Array {
  switch (kind) {
    case "p2wkh":
      return btc.p2wpkh(publicKey).script;
    case "np2wkh":
      return btc.p2sh(btc.p2wpkh(publicKey)).script;
    case "p2tr":
      return btc.p2tr(publicKey.subarray(1)).script;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const TXID_RE = /^[0-9a-f]{64}$/;

function checkInput(u: OwnedUtxo, i: number, allowUnconfirmed: boolean): void {
  const where = `input ${i} (${String(u.txid).slice(0, 16)}...:${u.vout})`;
  if (typeof u.txid !== "string" || !TXID_RE.test(u.txid)) {
    throw new SweepError("bad-input", `${where}: txid must be 64 lower-case hex characters.`);
  }
  if (!Number.isInteger(u.vout) || u.vout < 0) throw new SweepError("bad-input", `${where}: output index must be a non-negative integer.`);
  if (!Number.isInteger(u.value) || u.value <= 0) throw new SweepError("bad-input", `${where}: value must be a positive whole number of satoshis.`);
  const owner = u.owner;
  if (!owner || !(owner.scriptPubKey instanceof U8) || !(owner.publicKey instanceof U8)) {
    throw new SweepError("bad-input", `${where}: missing owner key data.`);
  }
  if (owner.publicKey.length !== 33) throw new SweepError("bad-input", `${where}: owner public key must be 33 bytes.`);
  const check = validateDestination(owner.address, owner.network);
  if (!check.ok) throw new SweepError("bad-input", `${where}: owner address is invalid: ${check.reason}`);
  if (!bytesEqual(check.scriptPubKey, owner.scriptPubKey)) {
    throw new SweepError("bad-input", `${where}: owner scriptPubKey does not match address ${owner.address}.`);
  }
  const expectedKind = check.kind === "p2sh" ? "np2wkh" : check.kind === "p2wpkh" ? "p2wkh" : check.kind === "p2tr" ? "p2tr" : null;
  if (expectedKind !== owner.kind) {
    throw new SweepError("bad-input", `${where}: address ${owner.address} is ${check.kind}, which is not a ${owner.kind} wallet address.`);
  }
  let fromKey: Uint8Array;
  try {
    fromKey = scriptForOwnerKey(owner.kind, owner.publicKey);
  } catch (e) {
    throw new SweepError("bad-input", `${where}: owner public key is invalid (${errorMessage(e)}).`);
  }
  if (!bytesEqual(fromKey, owner.scriptPubKey)) {
    throw new SweepError("bad-input", `${where}: owner public key does not produce the script of ${owner.address}.`);
  }
  if (!u.status || u.status.confirmed !== true) {
    if (!allowUnconfirmed) {
      throw new SweepError(
        "unconfirmed-input",
        `${where}: this output is not yet confirmed. Wait for a block, or explicitly allow unconfirmed inputs.`,
      );
    }
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Deterministic input order: txid ascending, then vout ascending. */
export function sortInputs(utxos: readonly OwnedUtxo[]): OwnedUtxo[] {
  return [...utxos].sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
}

export function planSweep(
  utxos: readonly OwnedUtxo[],
  destination: string,
  feeRateSatPerVb: number,
  options: SweepOptions = {},
): PreparedSweep {
  try {
    return planSweepInner(utxos, destination, feeRateSatPerVb, options);
  } catch (e) {
    if (e instanceof SweepError) throw e;
    // Nothing below should throw anything else; if a library does, it is still a caller-data problem.
    throw new SweepError("bad-input", `Could not build the sweep plan from the given inputs: ${errorMessage(e)}`);
  }
}

function planSweepInner(utxos: readonly OwnedUtxo[], destination: string, feeRateSatPerVb: number, options: SweepOptions): PreparedSweep {
  if (!isArray(utxos) || utxos.length === 0) throw new SweepError("no-inputs", "There is nothing to sweep: no unspent outputs were given.");

  const maxRate = options.maxFeeRateSatPerVb ?? DEFAULT_MAX_FEE_RATE;
  if (typeof feeRateSatPerVb !== "number" || Number.isNaN(feeRateSatPerVb) || feeRateSatPerVb < MIN_FEE_RATE) {
    throw new SweepError("fee-rate-too-low", `Fee rate must be at least ${MIN_FEE_RATE} sat/vB.`);
  }
  if (feeRateSatPerVb > maxRate) {
    throw new SweepError("fee-rate-too-high", `Fee rate ${feeRateSatPerVb} sat/vB is above the sanity cap of ${maxRate} sat/vB. Raise the cap if you really mean it.`);
  }

  utxos.forEach((u, i) => checkInput(u, i, options.allowUnconfirmed === true));
  const network = utxos[0]!.owner.network;
  const seen = new Set<string>();
  for (const u of utxos) {
    if (u.owner.network !== network) throw new SweepError("mixed-networks", `Inputs are on different networks (${network} and ${u.owner.network}).`);
    const key = `${u.txid}:${u.vout}`;
    if (seen.has(key)) throw new SweepError("duplicate-input", `Output ${key} appears more than once.`);
    seen.add(key);
  }

  const dest = validateDestination(destination, network);
  if (!dest.ok) throw new SweepError("bad-destination", dest.reason);

  // Our own copies: the caller's objects are neither aliased nor frozen.
  const inputs = sortInputs(utxos).map(copyInput);
  const total = inputs.reduce((sum, u) => sum + u.value, 0);
  if (!Number.isSafeInteger(total)) throw new SweepError("bad-input", "Total value is too large to represent exactly.");

  const estimatedVsize = estimateSweepVsize(
    inputs.map((u) => u.owner.kind),
    dest.kind,
  );
  const feeSats = feeForVsize(estimatedVsize, feeRateSatPerVb);
  if (feeSats >= total) {
    throw new SweepError(
      "fee-exceeds-total",
      `The fee of ${feeSats} sats at ${feeRateSatPerVb} sat/vB is more than the ${total} sats being swept, so there would be nothing left to send. Lower the fee rate or add more inputs.`,
    );
  }
  const outputSats = total - feeSats;
  const dust = DUST_SATS[dest.kind];
  if (outputSats < dust) {
    throw new SweepError(
      "dust",
      `After the fee of ${feeSats} sats the output would be ${outputSats} sats, below the ${dust} sat dust limit for a ${dest.kind} output. Lower the fee rate or add more inputs.`,
    );
  }
  const maxFraction = options.maxFeeFraction ?? DEFAULT_MAX_FEE_FRACTION;
  if (!options.allowHighFee && feeSats > total * maxFraction) {
    const pct = ((feeSats / total) * 100).toFixed(1);
    throw new SweepError(
      "fee-too-large",
      `The fee of ${feeSats} sats is ${pct}% of the ${total} sats being swept, above the ${Math.round(maxFraction * 100)}% limit. Lower the fee rate, or confirm you accept a high fee.`,
    );
  }

  let lockTime = 0;
  if (options.tipHeight !== undefined) {
    if (!Number.isInteger(options.tipHeight) || options.tipHeight < 0 || options.tipHeight >= 500_000_000) {
      throw new SweepError("bad-plan", `tipHeight ${options.tipHeight} is not a valid block height.`);
    }
    lockTime = options.tipHeight;
  }

  const committed: CommittedFields = {
    inputs,
    destination,
    feeRateSatPerVb,
    feeSats,
    outputSats,
    network,
    destinationKind: dest.kind,
    destinationScript: dest.scriptPubKey,
    lockTime,
    sequence: RBF_SEQUENCE,
    version: 2,
  };
  return register(deepFreezePlan({ ...committed, estimatedVsize, commitment: commit(committed) }));
}
