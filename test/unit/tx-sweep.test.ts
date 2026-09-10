import { describe, expect, it } from "vitest";
import { planSweep, SweepError, estimateSweepVsize } from "../../src/tx";
import { DUST_SATS, type DestinationKind } from "../../src/address";
import type { AddressKind, OwnedUtxo } from "../../src/types";
import { addressFor, derivedAddress, fixtureKeys, ownedUtxo, randomKey } from "./tx-fixtures";
import * as btc from "@scure/btc-signer";

const keys49 = fixtureKeys("random1-default", "regtest", 49);
const keys84 = fixtureKeys("random1-default", "regtest", 84);
const keys86 = fixtureKeys("random1-default", "regtest", 86);
const DEST_P2WPKH = "bcrt1qce2h7amnjmwxsvk60g8thr4kqzk4uvlyzdmgxl"; // fixture address, not one of the inputs below
const REG = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

function utxoOf(kind: AddressKind, value: number, i = 0, change: 0 | 1 = 0): OwnedUtxo {
  const key = kind === "np2wkh" ? keys49[i + 1]! : kind === "p2wkh" ? keys84[i + 1]! : keys86[i + 1]!;
  return ownedUtxo(derivedAddress(key, kind, "regtest", change, i), value);
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SweepError) return e.code;
    throw e;
  }
  throw new Error("did not throw");
}

describe("planSweep: arithmetic", () => {
  it("fee = ceil(vsize x rate), output = total - fee", () => {
    const utxos = [utxoOf("p2wkh", 100_000), utxoOf("p2tr", 250_000, 1), utxoOf("np2wkh", 12_345, 2)];
    const plan = planSweep(utxos, DEST_P2WPKH, 2.5, { tipHeight: 800_000 });
    const vsize = estimateSweepVsize(["p2wkh", "p2tr", "np2wkh"], "p2wpkh");
    expect(plan.estimatedVsize).toBe(vsize);
    expect(plan.feeSats).toBe(Math.ceil(vsize * 2.5));
    expect(plan.outputSats).toBe(362_345 - plan.feeSats);
    expect(plan.feeRateSatPerVb).toBe(2.5);
    expect(plan.destination).toBe(DEST_P2WPKH);
    expect(plan.lockTime).toBe(800_000);
    expect(plan.sequence).toBe(0xfffffffd);
    expect(plan.version).toBe(2);
    expect(plan.network).toBe("regtest");
    expect(plan.destinationKind).toBe("p2wpkh");
    expect(plan.inputs).toHaveLength(3);
  });
  it("lockTime is 0 when no tip height is given", () => {
    expect(planSweep([utxoOf("p2wkh", 100_000)], DEST_P2WPKH, 1).lockTime).toBe(0);
  });
  it("sorts inputs by txid then vout, whatever order they arrive in", () => {
    const o = derivedAddress(keys84[3]!, "p2wkh", "regtest");
    const a = ownedUtxo(o, 10_000, "aa".repeat(32), 1);
    const b = ownedUtxo(o, 10_000, "aa".repeat(32), 0);
    const c = ownedUtxo(o, 10_000, "0f".repeat(32), 7);
    const d = ownedUtxo(o, 10_000, "ff".repeat(32), 0);
    const expected = [c, b, a, d].map((u) => `${u.txid}:${u.vout}`);
    for (const order of [[a, b, c, d], [d, c, b, a], [b, d, a, c]]) {
      const plan = planSweep(order, DEST_P2WPKH, 1);
      expect(plan.inputs.map((u) => `${u.txid}:${u.vout}`)).toEqual(expected);
    }
  });
  it("does not mutate the caller's array", () => {
    const utxos = [utxoOf("p2wkh", 10_000, 0), utxoOf("p2wkh", 10_000, 1)];
    const copy = [...utxos];
    planSweep(utxos, DEST_P2WPKH, 1);
    expect(utxos).toEqual(copy);
  });
});

describe("planSweep: dust", () => {
  const kinds: DestinationKind[] = ["p2pkh", "p2sh", "p2wpkh", "p2wsh", "p2tr"];
  for (const kind of kinds) {
    it(`${kind}: output of exactly ${DUST_SATS[kind]} sats is allowed, one less is dust`, () => {
      const dest = destinationOf(kind);
      const fee = Math.ceil(estimateSweepVsize(["p2wkh"], kind) * 1);
      const ok = planSweep([utxoOf("p2wkh", fee + DUST_SATS[kind])], dest, 1, { allowHighFee: true });
      expect(ok.outputSats).toBe(DUST_SATS[kind]);
      expect(code(() => planSweep([utxoOf("p2wkh", fee + DUST_SATS[kind] - 1)], dest, 1, { allowHighFee: true }))).toBe("dust");
    });
  }
  it("total at or below the fee is fee-exceeds-total with a plain message, not dust", () => {
    let err: unknown;
    try {
      planSweep([utxoOf("p2wkh", 50)], DEST_P2WPKH, 1, { allowHighFee: true });
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(SweepError);
    expect((err as SweepError).code).toBe("fee-exceeds-total");
    expect((err as SweepError).message).not.toMatch(/-\d/);
    expect((err as SweepError).message).toMatch(/50 sats/);
    expect((err as SweepError).message).toMatch(/110 sats/);
    expect(code(() => planSweep([utxoOf("p2wkh", 110)], DEST_P2WPKH, 1, { allowHighFee: true }))).toBe("fee-exceeds-total");
    expect(code(() => planSweep([utxoOf("p2wkh", 111)], DEST_P2WPKH, 1, { allowHighFee: true }))).toBe("dust");
  });
});

describe("planSweep: fee rate limits", () => {
  const utxos = [utxoOf("p2wkh", 1_000_000)];
  it("rejects below 1 sat/vB", () => {
    expect(code(() => planSweep(utxos, DEST_P2WPKH, 0.99))).toBe("fee-rate-too-low");
    expect(code(() => planSweep(utxos, DEST_P2WPKH, 0))).toBe("fee-rate-too-low");
    expect(code(() => planSweep(utxos, DEST_P2WPKH, -3))).toBe("fee-rate-too-low");
    expect(code(() => planSweep(utxos, DEST_P2WPKH, Number.NaN))).toBe("fee-rate-too-low");
    expect(planSweep(utxos, DEST_P2WPKH, 1).feeSats).toBe(110);
  });
  it("rejects above the sanity cap (default 500 sat/vB), cap is overridable", () => {
    expect(planSweep(utxos, DEST_P2WPKH, 500).feeSats).toBe(55_000);
    expect(code(() => planSweep(utxos, DEST_P2WPKH, 501))).toBe("fee-rate-too-high");
    expect(code(() => planSweep(utxos, DEST_P2WPKH, Number.POSITIVE_INFINITY))).toBe("fee-rate-too-high");
    expect(planSweep(utxos, DEST_P2WPKH, 800, { maxFeeRateSatPerVb: 1000 }).feeSats).toBe(88_000);
    expect(code(() => planSweep(utxos, DEST_P2WPKH, 1001, { maxFeeRateSatPerVb: 1000 }))).toBe("fee-rate-too-high");
  });
  it("rejects a fee above the configured fraction of the total unless allowHighFee", () => {
    // 110 vB at 100 sat/vB = 11_000 fee. Total 50_000 -> 22%.
    const u = [utxoOf("p2wkh", 50_000)];
    expect(code(() => planSweep(u, DEST_P2WPKH, 100))).toBe("fee-too-large");
    expect(planSweep(u, DEST_P2WPKH, 100, { allowHighFee: true }).feeSats).toBe(11_000);
    expect(planSweep(u, DEST_P2WPKH, 100, { maxFeeFraction: 0.25 }).feeSats).toBe(11_000);
    expect(code(() => planSweep(u, DEST_P2WPKH, 100, { maxFeeFraction: 0.1 }))).toBe("fee-too-large");
    // Exactly at the fraction is allowed.
    expect(planSweep(u, DEST_P2WPKH, 100, { maxFeeFraction: 0.22 }).feeSats).toBe(11_000);
  });
});

describe("planSweep: destination", () => {
  it("rejects an invalid destination with the validator's reason", () => {
    const utxos = [utxoOf("p2wkh", 100_000)];
    let err: unknown;
    try {
      planSweep(utxos, "bcrt1qce2h7amnjmwxsvk60g8thr4kqzk4uvlyzdmgxx", 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SweepError);
    expect((err as SweepError).code).toBe("bad-destination");
    expect((err as SweepError).message).toMatch(/checksum/);
  });
  it("rejects a destination on the wrong network", () => {
    const utxos = [utxoOf("p2wkh", 100_000)];
    expect(code(() => planSweep(utxos, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 1))).toBe("bad-destination");
  });
  it("accepts every supported destination kind and reports it", () => {
    for (const kind of ["p2pkh", "p2sh", "p2wpkh", "p2wsh", "p2tr"] as DestinationKind[]) {
      const plan = planSweep([utxoOf("p2tr", 100_000)], destinationOf(kind), 1);
      expect(plan.destinationKind).toBe(kind);
      expect(plan.estimatedVsize).toBe(estimateSweepVsize(["p2tr"], kind));
    }
  });
});

describe("planSweep: unconfirmed inputs", () => {
  const o = derivedAddress(keys84[7]!, "p2wkh", "regtest");
  const unconfirmed: OwnedUtxo = { ...ownedUtxo(o, 100_000), status: { confirmed: false } };
  it("refuses unconfirmed inputs by default", () => {
    expect(code(() => planSweep([unconfirmed], DEST_P2WPKH, 1))).toBe("unconfirmed-input");
    expect(code(() => planSweep([utxoOf("p2wkh", 100_000, 1), unconfirmed], DEST_P2WPKH, 1))).toBe("unconfirmed-input");
  });
  it("accepts them with allowUnconfirmed: true", () => {
    const plan = planSweep([unconfirmed], DEST_P2WPKH, 1, { allowUnconfirmed: true });
    expect(plan.inputs).toHaveLength(1);
  });
  it("a missing status is treated as unconfirmed", () => {
    const noStatus = { ...unconfirmed, status: undefined } as unknown as OwnedUtxo;
    expect(code(() => planSweep([noStatus], DEST_P2WPKH, 1))).toBe("unconfirmed-input");
  });
});

describe("planSweep: input sanity", () => {
  it("rejects an empty list", () => {
    expect(code(() => planSweep([], DEST_P2WPKH, 1))).toBe("no-inputs");
  });
  it("rejects mixed networks", () => {
    const signetKey = fixtureKeys("random1-default", "testnet", 84)[1]!;
    const s = ownedUtxo(derivedAddress(signetKey, "p2wkh", "testnet"), 10_000);
    expect(code(() => planSweep([utxoOf("p2wkh", 10_000), s], DEST_P2WPKH, 1))).toBe("mixed-networks");
  });
  it("rejects duplicate outpoints", () => {
    const o = derivedAddress(keys84[5]!, "p2wkh", "regtest");
    const t = "ab".repeat(32);
    expect(code(() => planSweep([ownedUtxo(o, 10_000, t, 1), ownedUtxo(o, 10_000, t, 1)], DEST_P2WPKH, 1))).toBe("duplicate-input");
  });
  it("rejects bad values and txids", () => {
    const o = derivedAddress(keys84[5]!, "p2wkh", "regtest");
    expect(code(() => planSweep([ownedUtxo(o, 0)], DEST_P2WPKH, 1))).toBe("bad-input");
    expect(code(() => planSweep([ownedUtxo(o, -5)], DEST_P2WPKH, 1))).toBe("bad-input");
    expect(code(() => planSweep([ownedUtxo(o, 10.5)], DEST_P2WPKH, 1))).toBe("bad-input");
    expect(code(() => planSweep([ownedUtxo(o, 10_000, "zz".repeat(32))], DEST_P2WPKH, 1))).toBe("bad-input");
    expect(code(() => planSweep([ownedUtxo(o, 10_000, "ab".repeat(31))], DEST_P2WPKH, 1))).toBe("bad-input");
    expect(code(() => planSweep([ownedUtxo(o, 10_000, "ab".repeat(32), -1)], DEST_P2WPKH, 1))).toBe("bad-input");
  });
  it("wraps library exceptions as bad-input naming the field", () => {
    const o = derivedAddress(keys84[5]!, "p2wkh", "regtest");
    const garbage = { ...o, publicKey: new Uint8Array(33).fill(0xff) }; // not a curve point: scure throws
    let err: unknown;
    try {
      planSweep([ownedUtxo(garbage, 10_000)], DEST_P2WPKH, 1);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(SweepError);
    expect((err as SweepError).code).toBe("bad-input");
    expect((err as SweepError).message).toMatch(/input 0/);
    expect((err as SweepError).message).toMatch(/public key/i);
  });
  it("rejects an owner whose publicKey does not produce its scriptPubKey", () => {
    const o = derivedAddress(keys84[5]!, "p2wkh", "regtest");
    const wrongPub = { ...o, publicKey: keys84[6]!.publicKey };
    expect(code(() => planSweep([ownedUtxo(wrongPub, 10_000)], DEST_P2WPKH, 1))).toBe("bad-input");
  });
  it("rejects an owner whose scriptPubKey does not match its address", () => {
    const o = derivedAddress(keys84[5]!, "p2wkh", "regtest");
    const other = derivedAddress(keys84[6]!, "p2wkh", "regtest");
    const bad = { ...o, scriptPubKey: other.scriptPubKey };
    expect(code(() => planSweep([ownedUtxo(bad, 10_000)], DEST_P2WPKH, 1))).toBe("bad-input");
  });
});

function destinationOf(kind: DestinationKind): string {
  const key = randomKey();
  switch (kind) {
    case "p2pkh":
      return btc.p2pkh(key.publicKey, REG).address!;
    case "p2sh":
      return btc.p2sh(btc.p2wpkh(key.publicKey, REG), REG).address!;
    case "p2wpkh":
      return addressFor("p2wkh", key.publicKey, "regtest");
    case "p2wsh":
      return btc.p2wsh(btc.p2pkh(key.publicKey, REG), REG).address!;
    case "p2tr":
      return addressFor("p2tr", key.publicKey, "regtest");
  }
}
