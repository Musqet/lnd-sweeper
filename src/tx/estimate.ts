/**
 * Exact virtual-size estimation for a sweep transaction.
 *
 * A sweep has n inputs of lnd's three wallet kinds and exactly one output.
 * Sizes are counted from the serialisation rules (BIP141 weight, BIP144 witness):
 *   weight = 4 x (non-witness bytes) + witness bytes;  vsize = ceil(weight / 4).
 *
 * Signature sizes assume what our signer produces: ECDSA signatures are ground to
 * low-R (DER 70 bytes) plus one SIGHASH_ALL byte = 71; Schnorr key-path signatures
 * are 64 bytes with SIGHASH_DEFAULT and no sighash byte. A low-R DER signature can
 * only ever be shorter than 70 bytes, never longer, so the estimate is an upper bound.
 */
import { SCRIPT_LEN, type DestinationKind } from "../address";
import type { AddressKind } from "../types";

/** Compact-size integer length in bytes. */
export function varintLen(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

const OUTPOINT_AND_SEQUENCE = 32 + 4 + 4; // txid, vout, nSequence
const ECDSA_SIG_WITH_SIGHASH = 71; // low-R DER (70) + 1 sighash byte
const COMPRESSED_PUBKEY = 33;
const SCHNORR_SIG = 64;
const NP2WKH_SCRIPT_SIG = 23; // OP_PUSH22 0x00 0x14 <20-byte hash>

/** Per-input non-witness bytes (counted x4 in weight) and witness bytes (counted x1). */
export const INPUT_WEIGHT: Record<AddressKind, { base: number; witness: number }> = {
  np2wkh: {
    base: OUTPOINT_AND_SEQUENCE + varintLen(NP2WKH_SCRIPT_SIG) + NP2WKH_SCRIPT_SIG,
    witness: 1 + (1 + ECDSA_SIG_WITH_SIGHASH) + (1 + COMPRESSED_PUBKEY),
  },
  p2wkh: {
    base: OUTPOINT_AND_SEQUENCE + varintLen(0),
    witness: 1 + (1 + ECDSA_SIG_WITH_SIGHASH) + (1 + COMPRESSED_PUBKEY),
  },
  p2tr: {
    base: OUTPOINT_AND_SEQUENCE + varintLen(0),
    witness: 1 + (1 + SCHNORR_SIG),
  },
};

/** Serialised output size: 8-byte value, script length prefix, script. */
export const OUTPUT_SIZE: Record<DestinationKind, number> = {
  p2pkh: 8 + varintLen(SCRIPT_LEN.p2pkh) + SCRIPT_LEN.p2pkh,
  p2sh: 8 + varintLen(SCRIPT_LEN.p2sh) + SCRIPT_LEN.p2sh,
  p2wpkh: 8 + varintLen(SCRIPT_LEN.p2wpkh) + SCRIPT_LEN.p2wpkh,
  p2wsh: 8 + varintLen(SCRIPT_LEN.p2wsh) + SCRIPT_LEN.p2wsh,
  p2tr: 8 + varintLen(SCRIPT_LEN.p2tr) + SCRIPT_LEN.p2tr,
};

/** Transaction weight in weight units for a sweep of these inputs to one output. */
export function estimateSweepWeight(inputs: readonly AddressKind[], output: DestinationKind): number {
  if (inputs.length === 0) throw new Error("estimateSweepWeight: at least one input is required");
  let base = 4 + varintLen(inputs.length) + varintLen(1) + OUTPUT_SIZE[output] + 4; // version, counts, output, lockTime
  let witness = 2; // segwit marker and flag; every lnd wallet input kind is segwit
  for (const kind of inputs) {
    const w = INPUT_WEIGHT[kind];
    base += w.base;
    witness += w.witness;
  }
  return base * 4 + witness;
}

/** Virtual size in vbytes, rounded up as Bitcoin Core does. */
export function estimateSweepVsize(inputs: readonly AddressKind[], output: DestinationKind): number {
  return Math.ceil(estimateSweepWeight(inputs, output) / 4);
}

/** Fee in satoshis for a size and rate, rounded up so the effective rate is never below the target. */
export function feeForVsize(vsize: number, feeRateSatPerVb: number): number {
  return Math.ceil(vsize * feeRateSatPerVb);
}
