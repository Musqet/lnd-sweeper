import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as txModule from "../../src/tx";
import { planSweep, signSweep, verifySignedSweep, SweepError, estimateSweepVsize, RBF_SEQUENCE } from "../../src/tx";
import type { AddressKind, OwnedUtxo } from "../../src/types";
import { addressFor, derivedAddress, fixtureKeys, keyRing, ownedUtxo, scriptFor, type FixtureKey } from "./tx-fixtures";

const SEEDS = ["random1-default", "zeros-default-pass", "lnd-entropy-strong-pass-2018"];

describe("chantools fixtures agree with our script construction", () => {
  for (const seed of SEEDS) {
    for (const network of ["regtest", "testnet", "mainnet"] as const) {
      for (const purpose of [49, 84, 86] as const) {
        it(`${seed} ${network} ${purpose}: every labelled address matches the WIF`, () => {
          const keys = fixtureKeys(seed, network, purpose);
          expect(keys.length).toBeGreaterThan(10);
          for (const k of keys) {
            for (const kind of ["np2wkh", "p2wkh", "p2tr"] as AddressKind[]) {
              expect(addressFor(kind, k.publicKey, network)).toBe(k.addresses[kind]);
            }
          }
        });
      }
    }
  }
});

const k49 = fixtureKeys("random1-default", "regtest", 49);
const k84 = fixtureKeys("random1-default", "regtest", 84);
const k86 = fixtureKeys("random1-default", "regtest", 86);
const DEST = k84[0]!.addresses.p2wkh;

function entry(kind: AddressKind, i: number, change: 0 | 1 = 0) {
  const key: FixtureKey = (kind === "np2wkh" ? k49 : kind === "p2wkh" ? k84 : k86)[i + 1]!;
  return { key, owner: derivedAddress(key, kind, "regtest", change, i) };
}

function witnessOf(parsed: btc.Transaction, i: number): Uint8Array[] {
  const w = parsed.getInput(i).finalScriptWitness;
  if (!w) throw new Error("no witness");
  return w;
}

describe("signSweep", () => {
  const entries = [entry("np2wkh", 0), entry("p2wkh", 1, 1), entry("p2tr", 2), entry("p2wkh", 3), entry("p2tr", 4, 1), entry("np2wkh", 5, 1)];
  const utxos: OwnedUtxo[] = entries.map((e, i) => ownedUtxo(e.owner, 100_000 * (i + 1) + 17));
  const total = utxos.reduce((s, u) => s + u.value, 0);
  const plan = planSweep(utxos, DEST, 4, { tipHeight: 1234 });
  const ring = keyRing(entries);
  const signed = signSweep(plan, ring.keyFor);
  const raw = hexToBytes(signed.rawTxHex);
  const parsed = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true });

  it("returns the plan fields plus txid, hex and actual vsize", () => {
    expect(signed.inputs).toEqual(plan.inputs);
    expect(signed.destination).toBe(DEST);
    expect(signed.feeRateSatPerVb).toBe(4);
    expect(signed.estimatedVsize).toBe(plan.estimatedVsize);
    expect(signed.feeSats).toBe(plan.feeSats);
    expect(signed.outputSats).toBe(plan.outputSats);
    expect(signed.txid).toBe(parsed.id);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.vsize).toBe(parsed.vsize);
    expect(signed.vsize).toBeLessThanOrEqual(signed.estimatedVsize);
    expect(signed.feeSats / signed.vsize).toBeGreaterThanOrEqual(4);
  });
  it("transaction structure: v2, lockTime, RBF sequence, one output, sorted inputs", () => {
    expect(parsed.version).toBe(2);
    expect(parsed.lockTime).toBe(1234);
    expect(parsed.inputsLength).toBe(6);
    expect(parsed.outputsLength).toBe(1);
    for (let i = 0; i < 6; i++) {
      const inp = parsed.getInput(i);
      expect(bytesToHex(inp.txid!)).toBe(plan.inputs[i]!.txid);
      expect(inp.index).toBe(plan.inputs[i]!.vout);
      expect(inp.sequence).toBe(0xfffffffd);
    }
    const out = parsed.getOutput(0);
    expect(out.amount).toBe(BigInt(total - plan.feeSats));
    expect(bytesToHex(out.script!)).toBe(bytesToHex(scriptFor("p2wkh", k84[0]!.publicKey, "regtest")));
  });
  it("np2wkh inputs carry the 23-byte scriptSig pushing the P2WPKH redeem script", () => {
    for (let i = 0; i < 6; i++) {
      const u = plan.inputs[i]!;
      const sig = parsed.getInput(i).finalScriptSig!;
      if (u.owner.kind === "np2wkh") {
        expect(sig.length).toBe(23);
        expect(bytesToHex(sig)).toBe("160014" + bytesToHex(btc.p2wpkh(u.owner.publicKey).hash));
      } else {
        expect(sig.length).toBe(0);
      }
    }
  });
  it("every signature verifies independently with @noble/curves", () => {
    const prevScripts = plan.inputs.map((u) => u.owner.scriptPubKey);
    const amounts = plan.inputs.map((u) => BigInt(u.value));
    for (let i = 0; i < 6; i++) {
      const u = plan.inputs[i]!;
      const w = witnessOf(parsed, i);
      if (u.owner.kind === "p2tr") {
        expect(w).toHaveLength(1);
        expect(w[0]!.length).toBe(64); // SIGHASH_DEFAULT, no sighash byte
        const hash = parsed.preimageWitnessV1(i, prevScripts, 0, amounts);
        expect(schnorr.verify(w[0]!, hash, u.owner.scriptPubKey.subarray(2))).toBe(true);
      } else {
        expect(w).toHaveLength(2);
        expect(bytesToHex(w[1]!)).toBe(bytesToHex(u.owner.publicKey));
        const sig = w[0]!;
        expect(sig[sig.length - 1]).toBe(1); // SIGHASH_ALL
        expect(sig.length).toBeLessThanOrEqual(71); // lowR grinding
        const scriptCode = btc.p2pkh(u.owner.publicKey).script;
        const hash = parsed.preimageWitnessV0(i, scriptCode, 1, BigInt(u.value));
        expect(secp256k1.verify(sig.subarray(0, -1), hash, u.owner.publicKey, { prehash: false, format: "der", lowS: true })).toBe(true);
      }
    }
  });
  it("zeroes every private key it was handed", () => {
    expect(ring.handed).toHaveLength(6);
    for (const k of ring.handed) expect(k.privateKey.every((b) => b === 0)).toBe(true);
  });
  it("signing the same plan twice gives the same txid, size and ECDSA witnesses (Schnorr uses fresh aux randomness)", () => {
    const again = signSweep(plan, keyRing(entries).keyFor);
    expect(again.txid).toBe(signed.txid);
    expect(again.vsize).toBe(signed.vsize);
    expect(again.feeSats).toBe(signed.feeSats);
    const p2 = btc.Transaction.fromRaw(hexToBytes(again.rawTxHex), { allowUnknownOutputs: true });
    expect(bytesToHex(p2.toBytes(true, false))).toBe(bytesToHex(parsed.toBytes(true, false)));
    for (let i = 0; i < 6; i++) {
      if (plan.inputs[i]!.owner.kind !== "p2tr") {
        expect(witnessOf(p2, i).map(bytesToHex)).toEqual(witnessOf(parsed, i).map(bytesToHex));
      }
    }
  });
});

describe("signSweep: refusals", () => {
  const e = entry("p2wkh", 7);
  const plan = planSweep([ownedUtxo(e.owner, 200_000)], DEST, 2);

  function code(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      if (err instanceof SweepError) return err.code;
      throw err;
    }
    throw new Error("did not throw");
  }

  it("rejects a key that does not match the input's script", () => {
    const wrong = entry("p2wkh", 8);
    const ring = keyRing([{ key: wrong.key, owner: e.owner }]);
    expect(code(() => signSweep(plan, ring.keyFor))).toBe("key-mismatch");
    for (const k of ring.handed) expect(k.privateKey.every((b) => b === 0)).toBe(true);
  });
  it("rejects a key whose publicKey field lies about the private key", () => {
    const liar = () => ({ ...e.owner, publicKey: entry("p2wkh", 9).key.publicKey, privateKey: Uint8Array.from(e.key.privateKey) });
    expect(code(() => signSweep(plan, liar))).toBe("key-mismatch");
  });
  it("rejects a private key of the wrong length", () => {
    const short = () => ({ ...e.owner, privateKey: e.key.privateKey.slice(0, 31) });
    expect(code(() => signSweep(plan, short))).toBe("key-mismatch");
  });
  it("propagates keyFor errors and zeroes keys already handed out", () => {
    const two = [entry("p2wkh", 10), entry("p2tr", 11)];
    const p2 = planSweep(two.map((x) => ownedUtxo(x.owner, 100_000)), DEST, 2);
    const first = keyRing(two);
    let calls = 0;
    const keyFor = (o: typeof e.owner) => {
      if (calls++ === 1) throw new Error("hardware wallet unplugged");
      return first.keyFor(o);
    };
    expect(() => signSweep(p2, keyFor)).toThrow(/unplugged/);
    expect(first.handed).toHaveLength(1);
    expect(first.handed[0]!.privateKey.every((b) => b === 0)).toBe(true);
  });
  it("the plan carries a 32-byte hex commitment that is deterministic", () => {
    expect(plan.commitment).toMatch(/^[0-9a-f]{64}$/);
    const again = planSweep([ownedUtxo(e.owner, 200_000, plan.inputs[0]!.txid, plan.inputs[0]!.vout)], DEST, 2);
    expect(again.commitment).toBe(plan.commitment);
    const other = planSweep([ownedUtxo(e.owner, 200_000, plan.inputs[0]!.txid, plan.inputs[0]!.vout)], DEST, 3);
    expect(other.commitment).not.toBe(plan.commitment);
  });
  it("refuses any plan field changed after planning (plan-tampered)", () => {
    const other = entry("p2tr", 13).owner.address;
    const otherScript = entry("p2tr", 13).owner.scriptPubKey;
    const tampered: Record<string, object> = {
      "destination string swapped": { ...plan, destination: other },
      "destination string swapped to a valid address of the same kind": { ...plan, destination: k84[14]!.addresses.p2wkh },
      "destinationScript swapped": { ...plan, destinationScript: otherScript },
      "destination and script swapped together": { ...plan, destination: other, destinationScript: otherScript, destinationKind: "p2tr" },
      "outputSats + 1": { ...plan, outputSats: plan.outputSats + 1 },
      "feeSats - 1": { ...plan, feeSats: plan.feeSats - 1 },
      "fee moved to output": { ...plan, outputSats: 0, feeSats: 200_000 },
      "fee and output rebalanced": { ...plan, outputSats: plan.outputSats + 1, feeSats: plan.feeSats - 1 },
      "inputs emptied": { ...plan, inputs: [] },
      "input value changed": { ...plan, inputs: [{ ...plan.inputs[0]!, value: plan.inputs[0]!.value + 1 }] },
      "input outpoint changed": { ...plan, inputs: [{ ...plan.inputs[0]!, vout: 1 }] },
      "lockTime changed": { ...plan, lockTime: 1 },
      "sequence changed": { ...plan, sequence: 0xffffffff },
      "feeRate changed": { ...plan, feeRateSatPerVb: 1 },
      "network changed": { ...plan, network: "mainnet" },
      "commitment changed": { ...plan, commitment: "00".repeat(32) },
      "commitment missing": (() => { const { commitment: _c, ...rest } = plan; return rest; })(),
      "bare SweepPlan without prepared fields": { inputs: plan.inputs, destination: plan.destination, feeRateSatPerVb: 2, estimatedVsize: plan.estimatedVsize, feeSats: plan.feeSats, outputSats: plan.outputSats },
    };
    for (const [what, bad] of Object.entries(tampered)) {
      const ring = keyRing([e]);
      expect(code(() => signSweep(bad as never, ring.keyFor)), what).toBe("plan-tampered");
      for (const k of ring.handed) expect(k.privateKey.every((b) => b === 0)).toBe(true);
    }
  });
  it("exposes no way to compute or forge a commitment", () => {
    expect((txModule as Record<string, unknown>).computeCommitment).toBeUndefined();
    expect(Object.keys(txModule).some((k) => /commit|key/i.test(k))).toBe(false);
  });
  it("refuses a re-pointed plan carrying a fresh random commitment", () => {
    const other = entry("p2tr", 13).owner;
    for (let i = 0; i < 20; i++) {
      const forged = { ...plan, destination: other.address, destinationScript: other.scriptPubKey, destinationKind: "p2tr", commitment: bytesToHex(btc.utils.randomPrivateKeyBytes()) };
      expect(code(() => signSweep(forged as never, keyRing([e]).keyFor))).toBe("plan-tampered");
    }
  });
  it("refuses a plan-shaped object built by hand, even with all fields internally consistent", () => {
    const handMade = {
      inputs: plan.inputs,
      destination: plan.destination,
      feeRateSatPerVb: plan.feeRateSatPerVb,
      estimatedVsize: plan.estimatedVsize,
      feeSats: plan.feeSats,
      outputSats: plan.outputSats,
      network: plan.network,
      destinationKind: plan.destinationKind,
      destinationScript: plan.destinationScript,
      lockTime: plan.lockTime,
      sequence: plan.sequence,
      version: 2,
      commitment: bytesToHex(btc.utils.randomPrivateKeyBytes()),
    };
    expect(code(() => signSweep(handMade as never, keyRing([e]).keyFor))).toBe("plan-tampered");
  });
  it("refuses any copy of the plan: only the object planSweep returned may be signed", () => {
    expect(code(() => signSweep({ ...plan }, keyRing([e]).keyFor))).toBe("plan-tampered");
    const roundTrip = JSON.parse(JSON.stringify(plan, (_k, v) => (v instanceof Uint8Array ? { $bytes: bytesToHex(v) } : v)), (_k, v) =>
      v && typeof v === "object" && "$bytes" in v ? hexToBytes(v.$bytes) : v,
    );
    expect(code(() => signSweep(roundTrip, keyRing([e]).keyFor))).toBe("plan-tampered");
    expect(code(() => signSweep(structuredClone(plan), keyRing([e]).keyFor))).toBe("plan-tampered");
  });
  it("signs the genuine object after the refusals above (the registry is not consumed by failed attempts)", () => {
    const signed = signSweep(plan, keyRing([e]).keyFor);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns a deeply frozen plan (typed array contents excepted, which the signer snapshots)", () => {
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.inputs)).toBe(true);
    for (const u of plan.inputs) {
      expect(Object.isFrozen(u)).toBe(true);
      expect(Object.isFrozen(u.status)).toBe(true);
      expect(Object.isFrozen(u.owner)).toBe(true);
    }
    // The plan holds its own copies, not the caller's objects.
    const src = ownedUtxo(e.owner, 200_000);
    const p2 = planSweep([src], DEST, 2);
    expect(p2.inputs[0]).not.toBe(src);
    expect(p2.inputs[0]!.owner).not.toBe(e.owner);
    expect(p2.inputs[0]!.owner.scriptPubKey).not.toBe(e.owner.scriptPubKey);
    expect(Object.isFrozen(src)).toBe(false); // caller's object untouched
  });
  it("an accessor cannot be installed on the returned plan, and assignment throws", () => {
    const real = plan.destinationScript;
    const attacker = entry("p2tr", 13).owner.scriptPubKey;
    let reads = 0;
    expect(() =>
      Object.defineProperty(plan, "destinationScript", { get: () => (reads++ < 2 ? real : attacker) }),
    ).toThrow(TypeError);
    expect(() => Object.defineProperty(plan.inputs[0]!.owner, "scriptPubKey", { get: () => attacker })).toThrow(TypeError);
    expect(() => Object.defineProperty(plan.inputs, 0, { get: () => plan.inputs[0] })).toThrow(TypeError);
    const other = planSweep([ownedUtxo(e.owner, 200_000, plan.inputs[0]!.txid, plan.inputs[0]!.vout)], entry("p2tr", 13).owner.address, 2);
    expect(() => Object.assign(plan, other)).toThrow(TypeError);
    expect(() => {
      (plan as { destination: string }).destination = other.destination;
    }).toThrow(TypeError);
    expect(plan.destination).toBe(DEST);
    const signed = signSweep(plan, keyRing([e]).keyFor);
    const parsed = btc.Transaction.fromRaw(hexToBytes(signed.rawTxHex), { allowUnknownOutputs: true });
    expect(bytesToHex(parsed.getOutput(0).script!)).toBe(bytesToHex(real));
  });
  it("in-place byte edits of destinationScript or an owner script are refused (snapshot + commitment)", () => {
    const fresh = planSweep([ownedUtxo(e.owner, 200_000)], DEST, 2);
    const attacker = entry("p2tr", 13).owner.scriptPubKey;
    const saved = Uint8Array.from(fresh.destinationScript);
    // Same length (22 vs 34) would matter for the output; use a same-length p2wkh script instead.
    const otherWpkh = entry("p2wkh", 14).owner.scriptPubKey;
    fresh.destinationScript.set(otherWpkh);
    expect(code(() => signSweep(fresh, keyRing([e]).keyFor))).toBe("plan-tampered");
    fresh.destinationScript.set(saved);
    const ownerScript = fresh.inputs[0]!.owner.scriptPubKey;
    const savedOwner = Uint8Array.from(ownerScript);
    ownerScript.set(entry("p2wkh", 14).owner.scriptPubKey);
    expect(code(() => signSweep(fresh, keyRing([e]).keyFor))).toBe("plan-tampered");
    ownerScript.set(savedOwner);
    const pub = fresh.inputs[0]!.owner.publicKey;
    pub[1]! ^= 0xff;
    expect(code(() => signSweep(fresh, keyRing([e]).keyFor))).toBe("plan-tampered");
    pub[1]! ^= 0xff;
    void attacker;
    expect(signSweep(fresh, keyRing([e]).keyFor).txid).toMatch(/^[0-9a-f]{64}$/);
  });
  it("a Proxy over the genuine plan is refused", () => {
    // An honest proxy is a different object, so the registry refuses it.
    const honest = new Proxy(plan, {});
    expect(code(() => signSweep(honest, keyRing([e]).keyFor))).toBe("plan-tampered");
    // A lying proxy over a frozen target violates the Proxy invariants: the engine throws a
    // TypeError before our code even sees the value. Either outcome is a refusal.
    const attacker = entry("p2tr", 13).owner.scriptPubKey;
    const lying = new Proxy(plan, { get: (t, k) => (k === "destinationScript" ? attacker : Reflect.get(t, k)) });
    let err: unknown;
    try {
      signSweep(lying, keyRing([e]).keyFor);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(SweepError);
    expect((err as SweepError).code).toBe("plan-tampered");
  });
  it("a replaced Uint8Array.from returning a stateful proxy cannot redirect the output", () => {
    const fresh = planSweep([ownedUtxo(e.owner, 200_000)], DEST, 2);
    const genuine = Uint8Array.from(fresh.destinationScript);
    const attacker = entry("p2wkh", 14).owner.scriptPubKey; // same length as the genuine p2wkh script
    const originalFrom = Uint8Array.from;
    let fromCalls = 0;
    const statefulFrom = function (this: unknown, src: ArrayLike<number> | Iterable<number>, ...rest: unknown[]) {
      fromCalls++;
      const real = (originalFrom as (...a: unknown[]) => Uint8Array).call(Uint8Array, src, ...rest);
      if (real.length !== genuine.length) return real;
      let reads = 0;
      // Honest for the first full pass (the HMAC), attacker bytes on every later read.
      return new Proxy(real, {
        get(t, k, r) {
          if (typeof k === "string" && /^\d+$/.test(k)) {
            reads++;
            if (reads > real.length) return attacker[Number(k)];
          }
          void r;
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    };
    Object.defineProperty(Uint8Array, "from", { value: statefulFrom, configurable: true, writable: true });
    let outcome: { signed: ReturnType<typeof signSweep> } | { err: unknown };
    try {
      outcome = { signed: signSweep(fresh, keyRing([e]).keyFor) };
    } catch (err) {
      outcome = { err };
    } finally {
      Object.defineProperty(Uint8Array, "from", { value: originalFrom, configurable: true, writable: true });
    }
    // Our module never calls Uint8Array.from, so its snapshot and HMAC see genuine bytes. The
    // replaced global is still visible to @scure/btc-signer internally; if it swallows the proxy
    // and serialises attacker bytes, independent verification must refuse. Either outcome is
    // safe: a transaction to the genuine script, or no transaction at all. Never the attacker.
    if ("signed" in outcome) {
      const parsed = btc.Transaction.fromRaw(hexToBytes(outcome.signed.rawTxHex), { allowUnknownOutputs: true });
      expect(bytesToHex(parsed.getOutput(0).script!)).toBe(bytesToHex(genuine));
    } else {
      expect(outcome.err).toBeInstanceOf(SweepError);
      expect((outcome.err as SweepError).code).toBe("verify-failed");
      expect((outcome.err as SweepError).message).toMatch(/output script is not the destination/);
    }
    expect(fromCalls).toBeGreaterThan(0); // the hostile global was really in place
    // With the real Uint8Array.from back, the same frozen plan signs to the genuine script.
    const signed = signSweep(fresh, keyRing([e]).keyFor);
    const parsed = btc.Transaction.fromRaw(hexToBytes(signed.rawTxHex), { allowUnknownOutputs: true });
    expect(bytesToHex(parsed.getOutput(0).script!)).toBe(bytesToHex(genuine));
  });
  it("a proxy whose get trap lies about the commitment is refused with plan-tampered, not a TypeError", () => {
    const lying = new Proxy(plan, {
      get: (t, k, r) => (k === "commitment" ? bytesToHex(btc.utils.randomPrivateKeyBytes()) : Reflect.get(t, k, r)),
    });
    let err: unknown;
    try {
      signSweep(lying, keyRing([e]).keyFor);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(SweepError);
    expect((err as SweepError).code).toBe("plan-tampered");
    // And one lying about a byte field, which previously surfaced the engine's invariant TypeError.
    const attacker = entry("p2tr", 13).owner.scriptPubKey;
    const lying2 = new Proxy(plan, { get: (t, k, r) => (k === "destinationScript" ? attacker : Reflect.get(t, k, r)) });
    expect(code(() => signSweep(lying2, keyRing([e]).keyFor))).toBe("plan-tampered");
    // Throwing getters too.
    const throwing = new Proxy(plan, {
      get: (t, k, r) => {
        if (k === "inputs") throw new RangeError("boom");
        return Reflect.get(t, k, r);
      },
    });
    expect(code(() => signSweep(throwing, keyRing([e]).keyFor))).toBe("plan-tampered");
  });
  it("refuses malformed inputs with bad-input, never an untyped TypeError", () => {
    const shapes: Record<string, unknown> = {
      "input without owner": [{ txid: plan.inputs[0]!.txid, vout: 0, value: 200_000, status: { confirmed: true } }],
      "input with null owner": [{ ...plan.inputs[0]!, owner: null }],
      "owner without scriptPubKey": [{ ...plan.inputs[0]!, owner: { ...e.owner, scriptPubKey: undefined } }],
      "owner with string publicKey": [{ ...plan.inputs[0]!, owner: { ...e.owner, publicKey: "02ab" } }],
      "input is a string": ["not an input"],
      "input is null": [null],
      "inputs not an array": "nope",
    };
    for (const [what, inputs] of Object.entries(shapes)) {
      const bad = { ...plan, inputs } as never;
      let err: unknown;
      try {
        signSweep(bad, keyRing([e]).keyFor);
      } catch (x) {
        err = x;
      }
      expect(err, what).toBeInstanceOf(SweepError);
      expect((err as SweepError).code, what).toBe("bad-input");
    }
  });
});

describe("verifySignedSweep: effective fee rate is recomputed from fee and actual vsize", () => {
  const e = entry("p2wkh", 15);
  const plan = planSweep([ownedUtxo(e.owner, 300_000)], DEST, 5);
  const signed = signSweep(plan, keyRing([e]).keyFor);
  const expected = { total: 300_000, lockTime: 0, destinationScript: plan.destinationScript };

  function code(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      if (err instanceof SweepError) return err.code;
      throw err;
    }
    throw new Error("did not throw");
  }

  it("passes for the genuine result", () => {
    expect(() => verifySignedSweep(signed, expected)).not.toThrow();
  });
  it("refuses when the claimed rate is above what fee/vsize delivers (tolerance 0.01)", () => {
    const actual = signed.feeSats / signed.vsize;
    expect(code(() => verifySignedSweep({ ...signed, feeRateSatPerVb: actual + 0.02 }, expected))).toBe("verify-failed");
    expect(() => verifySignedSweep({ ...signed, feeRateSatPerVb: actual + 0.009 }, expected)).not.toThrow();
  });
  it("refuses a transaction whose real rate is below 1 sat/vB, whatever the plan claims", () => {
    // Hand-build a valid 1-in-1-out transaction paying only 50 sats of fee.
    const tx = new btc.Transaction({ version: 2, lowR: true });
    const txid = plan.inputs[0]!.txid;
    tx.addInput({ txid, index: 0, sequence: RBF_SEQUENCE, witnessUtxo: { script: e.owner.scriptPubKey, amount: 300_000n } });
    tx.addOutput({ script: plan.destinationScript, amount: 299_950n });
    tx.signIdx(Uint8Array.from(e.key.privateKey), 0);
    tx.finalize();
    const cheap = { ...signed, rawTxHex: tx.hex, txid: tx.id, vsize: tx.vsize, feeSats: 50, outputSats: 299_950, feeRateSatPerVb: 0.1 };
    let err: unknown;
    try {
      verifySignedSweep(cheap, expected);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(SweepError);
    expect((err as SweepError).code).toBe("verify-failed");
    expect((err as SweepError).message).toMatch(/1 sat\/vB/);
  });
});

describe("signSweep: single-input sweeps of each kind to each destination kind", () => {
  const dests: [string, string][] = [
    ["p2wpkh", k84[0]!.addresses.p2wkh],
    ["p2sh", k49[0]!.addresses.np2wkh],
    ["p2tr", k86[0]!.addresses.p2tr],
    ["p2pkh", btc.p2pkh(k84[0]!.publicKey, { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef }).address!],
  ];
  for (const kind of ["np2wkh", "p2wkh", "p2tr"] as AddressKind[]) {
    for (const [dkind, dest] of dests) {
      it(`${kind} -> ${dkind}`, () => {
        const e = entry(kind, 12);
        const plan = planSweep([ownedUtxo(e.owner, 55_555)], dest, 1.5);
        const signed = signSweep(plan, keyRing([e]).keyFor);
        expect(signed.vsize).toBeLessThanOrEqual(estimateSweepVsize([kind], dkind as never));
        expect(signed.feeSats).toBeGreaterThanOrEqual(Math.ceil(signed.vsize * 1.5));
        const parsed = btc.Transaction.fromRaw(hexToBytes(signed.rawTxHex), { allowUnknownOutputs: true });
        expect(parsed.id).toBe(signed.txid);
        expect(parsed.getOutput(0).amount).toBe(BigInt(55_555 - signed.feeSats));
      });
    }
  }
});
