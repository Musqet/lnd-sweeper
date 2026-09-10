/**
 * Sign a sweep plan with @scure/btc-signer, then independently verify the result.
 *
 * Only the very object planSweep returned is accepted: signSweep checks it is registered and that
 * its keyed commitment still matches (see sweep.ts for the threat model), so any copy, JSON round
 * trip or field change since the user reviewed it is refused. The output is built from the
 * committed destinationScript, never from the destination string alone (which is checked against
 * the script, not trusted).
 *
 * Every private key handed to us is zeroed once its input is signed, and also on any error
 * path. Keys must therefore be fresh copies; keyFor() must not return a buffer the caller
 * wants to keep. The library derives a tweaked Taproot key internally for p2tr inputs; that
 * intermediate copy is not reachable from here.
 */
import * as btc from "@scure/btc-signer";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { validateDestination } from "../address";
import type { DerivedAddress, DerivedKey, SignedSweep, SweepPlan } from "../types";
import { bytesEqual, isGenuinePlan, RBF_SEQUENCE, scriptForOwnerKey, snapshotPlan, SweepError, type PreparedSweep } from "./sweep";

// Built-ins captured at module load; see sweep.ts for the threat model.
const U8 = Uint8Array;
const isArray = Array.isArray;

const SIGHASH_ALL = 1;
const SIGHASH_DEFAULT = 0;
/** How far below the requested rate the delivered rate may fall (rounding slack only). */
const RATE_TOLERANCE = 0.01;
const MIN_RELAY_RATE = 1;

function zero(keys: Iterable<DerivedKey>): void {
  for (const k of keys) k.privateKey?.fill(0);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tampered(what: string): never {
  throw new SweepError("plan-tampered", `The sweep plan has changed since it was prepared (${what}). Go back and prepare the sweep again.`);
}

/** Structural check that the object carries every prepared field with the right shape. */
function isPreparedSweep(plan: SweepPlan): plan is PreparedSweep {
  const p = plan as Partial<PreparedSweep>;
  return (
    typeof p.commitment === "string" &&
    /^[0-9a-f]{64}$/.test(p.commitment) &&
    p.destinationScript instanceof U8 &&
    typeof p.network === "string" &&
    typeof p.destinationKind === "string" &&
    typeof p.lockTime === "number" &&
    typeof p.sequence === "number" &&
    p.version === 2 &&
    isArray(p.inputs) &&
    typeof p.destination === "string" &&
    typeof p.feeRateSatPerVb === "number" &&
    typeof p.feeSats === "number" &&
    typeof p.outputSats === "number"
  );
}

/** Shape of every input, checked before anything dereferences it. */
function checkInputShapes(plan: SweepPlan): void {
  if (!isArray(plan.inputs)) throw new SweepError("bad-input", "The plan's inputs are not a list.");
  plan.inputs.forEach((u, i) => {
    const bad = (what: string): never => {
      throw new SweepError("bad-input", `Input ${i}: ${what}.`);
    };
    if (typeof u !== "object" || u === null) bad("not an object");
    if (typeof u.txid !== "string") bad("txid is not a string");
    if (typeof u.vout !== "number") bad("vout is not a number");
    if (typeof u.value !== "number") bad("value is not a number");
    const o = u.owner as Partial<DerivedAddress> | null | undefined;
    if (typeof o !== "object" || o === null) bad("owner is missing");
    if (typeof o!.address !== "string") bad("owner.address is not a string");
    if (typeof o!.network !== "string") bad("owner.network is not a string");
    if (o!.kind !== "np2wkh" && o!.kind !== "p2wkh" && o!.kind !== "p2tr") bad("owner.kind is not a wallet address kind");
    if (!(o!.publicKey instanceof U8)) bad("owner.publicKey is not bytes");
    if (!(o!.scriptPubKey instanceof U8)) bad("owner.scriptPubKey is not bytes");
  });
}

/**
 * Validates the caller's plan and returns a private snapshot of it. Every field of the caller's
 * object is read exactly once, inside snapshotPlan; everything after that, including the
 * commitment check, works on the snapshot, so a getter that changes its answer later is inert.
 */
function checkPlan(original: SweepPlan): PreparedSweep {
  let plan: PreparedSweep;
  // Reading a hostile object (a Proxy that lies or throws) can raise the engine's own errors;
  // any such failure is a tampered plan, never an untyped exception.
  try {
    if (typeof original !== "object" || original === null) tampered("it is not an object");
    checkInputShapes(original);
    if (!isPreparedSweep(original)) tampered("it was not produced by planSweep or is missing fields");
    plan = snapshotPlan(original);
    if (!isGenuinePlan(original, plan)) tampered("it is not the object planSweep returned, or its contents changed");
  } catch (e) {
    if (e instanceof SweepError) throw e;
    return tampered(`it could not be read safely: ${errorMessage(e)}`);
  }

  // Belt and braces: the registry and commitment already guarantee these, but they are cheap.
  if (plan.inputs.length === 0) tampered("it has no inputs");
  const total = plan.inputs.reduce((s, u) => s + u.value, 0);
  if (!Number.isSafeInteger(plan.feeSats) || plan.feeSats < 0) tampered("the fee is not a valid amount");
  if (!Number.isSafeInteger(plan.outputSats) || plan.outputSats <= 0) tampered("the output is not a positive amount");
  if (plan.feeSats + plan.outputSats !== total) tampered("inputs, fee and output do not balance");
  for (const u of plan.inputs) if (u.owner.network !== plan.network) tampered("an input is on a different network");
  if (plan.sequence !== RBF_SEQUENCE) tampered("the input sequence is not the RBF value");
  if (!Number.isInteger(plan.lockTime) || plan.lockTime < 0 || plan.lockTime > 0xffffffff) tampered("the lockTime is invalid");

  const dest = validateDestination(plan.destination, plan.network);
  if (!dest.ok) tampered(`the destination is not valid: ${dest.reason}`);
  if (dest.ok && (!bytesEqual(dest.scriptPubKey, plan.destinationScript) || dest.kind !== plan.destinationKind)) {
    tampered("the destination address and its output script disagree");
  }
  return plan;
}

/**
 * Sign the plan. keyFor() is called once per input, in plan order, and each key it
 * returns is zeroed after use.
 */
export function signSweep(plan: SweepPlan, keyFor: (owner: DerivedAddress) => DerivedKey): SignedSweep {
  const prepared = checkPlan(plan);
  const total = prepared.feeSats + prepared.outputSats;
  const keys: DerivedKey[] = [];
  try {
    const tx = new btc.Transaction({ version: 2, lockTime: prepared.lockTime, lowR: true });

    for (const [i, u] of prepared.inputs.entries()) {
      const key = keyFor(u.owner);
      keys.push(key);
      if (!(key.privateKey instanceof U8) || key.privateKey.length !== 32) {
        throw new SweepError("key-mismatch", `Input ${i}: the private key must be 32 bytes.`);
      }
      let publicKey: Uint8Array;
      try {
        publicKey = secp256k1.getPublicKey(key.privateKey, true);
      } catch (e) {
        throw new SweepError("key-mismatch", `Input ${i}: the private key is not valid (${errorMessage(e)}).`);
      }
      if (!bytesEqual(publicKey, u.owner.publicKey) || !bytesEqual(publicKey, key.publicKey)) {
        throw new SweepError("key-mismatch", `Input ${i}: the private key does not correspond to the public key of ${u.owner.address}.`);
      }
      let expectedScript: Uint8Array;
      try {
        expectedScript = scriptForOwnerKey(u.owner.kind, publicKey);
      } catch (e) {
        throw new SweepError("bad-input", `Input ${i}: owner public key is invalid (${errorMessage(e)}).`);
      }
      if (!bytesEqual(expectedScript, u.owner.scriptPubKey)) {
        throw new SweepError("key-mismatch", `Input ${i}: the key does not control ${u.owner.address}.`);
      }
      try {
        const wpkh = btc.p2wpkh(publicKey);
        tx.addInput({
          txid: u.txid,
          index: u.vout,
          sequence: RBF_SEQUENCE,
          witnessUtxo: { script: u.owner.scriptPubKey, amount: BigInt(u.value) },
          ...(u.owner.kind === "np2wkh" ? { redeemScript: wpkh.script } : {}),
          ...(u.owner.kind === "p2tr" ? { tapInternalKey: publicKey.subarray(1) } : {}),
        });
      } catch (e) {
        throw new SweepError("bad-input", `Input ${i} (txid ${u.txid}, vout ${u.vout}, value ${u.value}): ${errorMessage(e)}`);
      }
    }
    try {
      tx.addOutput({ script: prepared.destinationScript, amount: BigInt(prepared.outputSats) });
    } catch (e) {
      throw new SweepError("bad-destination", `Output (destination ${prepared.destination}, ${prepared.outputSats} sats): ${errorMessage(e)}`);
    }

    let rawTxHex: string;
    let txid: string;
    let vsize: number;
    let feeSats: number;
    try {
      for (const [i, key] of keys.entries()) {
        const ok = tx.signIdx(key.privateKey, i);
        key.privateKey.fill(0);
        if (!ok) throw new Error(`input ${i} could not be signed`);
      }
      tx.finalize();
      rawTxHex = tx.hex;
      txid = tx.id;
      vsize = tx.vsize;
      feeSats = Number(tx.fee);
    } catch (e) {
      throw new SweepError("verify-failed", `Signing failed: ${errorMessage(e)}`);
    }

    const signed: SignedSweep = { ...prepared, txid, rawTxHex, vsize, feeSats };
    if (feeSats !== prepared.feeSats) throw new SweepError("verify-failed", `Signed fee ${feeSats} differs from planned fee ${prepared.feeSats}.`);
    verifySignedSweep(signed, { total, lockTime: prepared.lockTime, destinationScript: prepared.destinationScript });
    return signed;
  } finally {
    zero(keys);
  }
}

/**
 * Re-parse the raw transaction and check everything we can without private keys:
 * structure, amounts, destination, delivered fee rate, and every signature against the
 * owner's key. Trusts nothing in `signed` that can be recomputed from the bytes.
 */
export function verifySignedSweep(
  signed: SignedSweep,
  expected: { total: number; lockTime: number; destinationScript: Uint8Array },
): void {
  const fail = (what: string): never => {
    throw new SweepError("verify-failed", `Signed transaction failed verification: ${what}.`);
  };
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromRaw(hexToBytes(signed.rawTxHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
  } catch (e) {
    return fail(`the raw transaction could not be parsed (${errorMessage(e)})`);
  }
  if (tx.id !== signed.txid) fail("txid mismatch");
  if (tx.version !== 2) fail(`version ${tx.version}`);
  if (tx.lockTime !== expected.lockTime) fail(`lockTime ${tx.lockTime}`);
  if (tx.vsize !== signed.vsize) fail("vsize mismatch");
  if (tx.inputsLength !== signed.inputs.length) fail("input count mismatch");
  if (tx.outputsLength !== 1) fail(`${tx.outputsLength} outputs`);
  const out = tx.getOutput(0);
  if (!out.script || !bytesEqual(out.script, expected.destinationScript)) fail("output script is not the destination");
  if (out.amount !== BigInt(signed.outputSats)) fail("output amount mismatch");
  if (expected.total - signed.outputSats !== signed.feeSats) fail("fee does not balance");

  // Fee rate actually delivered, from the fee and the real size; the plan's rate is only a claim.
  const effectiveRate = signed.feeSats / tx.vsize;
  if (!(effectiveRate >= MIN_RELAY_RATE)) {
    fail(`effective fee rate ${effectiveRate.toFixed(3)} sat/vB is below 1 sat/vB and would not relay`);
  }
  if (effectiveRate < signed.feeRateSatPerVb - RATE_TOLERANCE) {
    fail(`effective fee rate ${effectiveRate.toFixed(3)} sat/vB is below the requested ${signed.feeRateSatPerVb} sat/vB`);
  }

  const prevScripts = signed.inputs.map((u) => u.owner.scriptPubKey);
  const amounts = signed.inputs.map((u) => BigInt(u.value));
  for (const [i, u] of signed.inputs.entries()) {
    const inp = tx.getInput(i);
    if (!inp.txid || bytesToHex(inp.txid) !== u.txid || inp.index !== u.vout) fail(`input ${i} outpoint mismatch`);
    if (inp.sequence !== RBF_SEQUENCE) fail(`input ${i} sequence`);
    const witness = inp.finalScriptWitness;
    if (!witness) return fail(`input ${i} has no witness`);
    const scriptSig = inp.finalScriptSig ?? new Uint8Array();
    if (u.owner.kind === "p2tr") {
      if (scriptSig.length !== 0) fail(`input ${i} p2tr has a scriptSig`);
      if (witness.length !== 1 || witness[0]!.length !== 64) fail(`input ${i} p2tr witness shape`);
      const hash = tx.preimageWitnessV1(i, prevScripts, SIGHASH_DEFAULT, amounts);
      const outputKey = u.owner.scriptPubKey.subarray(2);
      if (!schnorr.verify(witness[0]!, hash, outputKey)) fail(`input ${i} Schnorr signature`);
    } else {
      const wpkh = btc.p2wpkh(u.owner.publicKey);
      if (u.owner.kind === "np2wkh") {
        const expectedSig = new Uint8Array([0x16, ...wpkh.script]);
        if (!bytesEqual(scriptSig, expectedSig)) fail(`input ${i} np2wkh scriptSig`);
      } else if (scriptSig.length !== 0) fail(`input ${i} p2wkh has a scriptSig`);
      if (witness.length !== 2) fail(`input ${i} witness shape`);
      const [sig, pub] = witness as [Uint8Array, Uint8Array];
      if (!bytesEqual(pub, u.owner.publicKey)) fail(`input ${i} witness public key`);
      if (sig.length < 9 || sig[sig.length - 1] !== SIGHASH_ALL) fail(`input ${i} sighash type`);
      const scriptCode = btc.p2pkh(u.owner.publicKey).script;
      const hash = tx.preimageWitnessV0(i, scriptCode, SIGHASH_ALL, BigInt(u.value));
      let ok = false;
      try {
        ok = secp256k1.verify(sig.subarray(0, -1), hash, u.owner.publicKey, { prehash: false, format: "der", lowS: true });
      } catch {
        ok = false;
      }
      if (!ok) fail(`input ${i} ECDSA signature`);
    }
  }
}
