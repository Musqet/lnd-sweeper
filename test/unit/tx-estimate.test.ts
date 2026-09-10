import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils.js";
import { estimateSweepVsize, estimateSweepWeight, feeForVsize, INPUT_WEIGHT, OUTPUT_SIZE } from "../../src/tx";
import { planSweep, signSweep } from "../../src/tx";
import type { DestinationKind } from "../../src/address";
import type { AddressKind } from "../../src/types";
import { addressFor, derivedAddress, keyRing, ownedUtxo, randomKey } from "./tx-fixtures";

const KINDS: AddressKind[] = ["np2wkh", "p2wkh", "p2tr"];
const OUT_KINDS: DestinationKind[] = ["p2pkh", "p2sh", "p2wpkh", "p2wsh", "p2tr"];

describe("estimateSweepVsize: hand-computed sizes", () => {
  it("per-input weights: np2wkh 64 base + 107 witness, p2wkh 41 + 107, p2tr 41 + 66", () => {
    expect(INPUT_WEIGHT.np2wkh).toEqual({ base: 64, witness: 107 });
    expect(INPUT_WEIGHT.p2wkh).toEqual({ base: 41, witness: 107 });
    expect(INPUT_WEIGHT.p2tr).toEqual({ base: 41, witness: 66 });
  });
  it("output sizes include value and length prefix", () => {
    expect(OUTPUT_SIZE).toEqual({ p2pkh: 34, p2sh: 32, p2wpkh: 31, p2wsh: 43, p2tr: 43 });
  });
  it("1 p2wkh in, 1 p2wpkh out = 110 vB (weight 437)", () => {
    expect(estimateSweepWeight(["p2wkh"], "p2wpkh")).toBe(437);
    expect(estimateSweepVsize(["p2wkh"], "p2wpkh")).toBe(110);
  });
  it("1 p2tr in, 1 p2tr out = 111 vB", () => {
    expect(estimateSweepVsize(["p2tr"], "p2tr")).toBe(111);
  });
  it("1 np2wkh in, 1 p2wpkh out = 133 vB", () => {
    expect(estimateSweepVsize(["np2wkh"], "p2wpkh")).toBe(133);
  });
  it("1 p2wkh in, 1 p2pkh out = 113 vB", () => {
    // base 4+1+41+1+34+4 = 85 -> 340, witness 2+107 = 109, weight 449 -> 112.25 -> 113
    expect(estimateSweepVsize(["p2wkh"], "p2pkh")).toBe(113);
  });
  it("varint boundary: 253 inputs costs two extra base bytes", () => {
    const w252 = estimateSweepWeight(Array(252).fill("p2wkh"), "p2wpkh");
    const w253 = estimateSweepWeight(Array(253).fill("p2wkh"), "p2wpkh");
    expect(w253 - w252).toBe((41 + 2) * 4 + 107);
  });
  it("rejects an empty input list", () => {
    expect(() => estimateSweepVsize([], "p2wpkh")).toThrow();
  });
});

describe("feeForVsize", () => {
  it("rounds up", () => {
    expect(feeForVsize(110, 2)).toBe(220);
    expect(feeForVsize(110, 2.5)).toBe(275);
    expect(feeForVsize(111, 1.1)).toBe(123); // 122.1 -> 123
    expect(feeForVsize(1, 1)).toBe(1);
  });
  it("is never below vsize x rate", () => {
    for (let v = 100; v < 3000; v += 37) {
      for (const r of [1, 1.01, 2.7, 13.37, 99.9]) {
        expect(feeForVsize(v, r)).toBeGreaterThanOrEqual(v * r);
        expect(feeForVsize(v, r) - v * r).toBeLessThan(1);
      }
    }
  });
});

describe("estimateSweepVsize vs actual signed vsize (random compositions)", () => {
  // Deterministic PRNG so failures are reproducible.
  let seed = 0x12345678;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const cases: { kinds: AddressKind[]; out: DestinationKind }[] = [];
  for (let i = 0; i < 120; i++) {
    const n = 1 + rnd(i < 100 ? 12 : 40);
    const kinds = Array.from({ length: n }, () => KINDS[rnd(3)]!);
    cases.push({ kinds, out: OUT_KINDS[rnd(OUT_KINDS.length)]! });
  }
  for (const k of KINDS) cases.push({ kinds: [k], out: "p2wpkh" }, { kinds: [k], out: "p2tr" }, { kinds: [k], out: "p2pkh" });

  for (const c of cases) {
    it(`${c.kinds.length} inputs (${c.kinds.join(",").slice(0, 60)}) -> ${c.out}`, () => {
      const entries = c.kinds.map((kind, i) => {
        const key = randomKey();
        return { key, owner: derivedAddress(key, kind, "regtest", (i % 2) as 0 | 1, i) };
      });
      const utxos = entries.map((e) => ownedUtxo(e.owner, 50_000 + rnd(1_000_000)));
      const destKey = randomKey();
      const destination = destinationAddress(c.out, destKey.publicKey);
      const plan = planSweep(utxos, destination, 3, { tipHeight: 500 });
      const estimate = estimateSweepVsize(c.kinds, c.out);
      expect(plan.estimatedVsize).toBe(estimate);
      const signed = signSweep(plan, keyRing(entries).keyFor);
      // Independent measurement of the actual vsize from the raw bytes.
      const parsed = btc.Transaction.fromRaw(hexToBytes(signed.rawTxHex), { allowUnknownOutputs: true });
      expect(signed.vsize).toBe(parsed.vsize);
      expect(signed.vsize).toBeLessThanOrEqual(estimate);
      // lowR grinding makes every ECDSA signature exactly 71 bytes except when R or S has a
      // leading zero byte (about 1 in 128 signatures), so the estimate is almost always exact.
      expect(estimate - signed.vsize).toBeLessThanOrEqual(2);
      expect(signed.feeSats / signed.vsize).toBeGreaterThanOrEqual(3);
    });
  }
});

function destinationAddress(kind: DestinationKind, publicKey: Uint8Array): string {
  const net = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
  switch (kind) {
    case "p2pkh":
      return btc.p2pkh(publicKey, net).address!;
    case "p2sh":
      return btc.p2sh(btc.p2wpkh(publicKey, net), net).address!;
    case "p2wpkh":
      return addressFor("p2wkh", publicKey, "regtest");
    case "p2wsh":
      return btc.p2wsh(btc.p2pkh(publicKey, net), net).address!;
    case "p2tr":
      return addressFor("p2tr", publicKey, "regtest");
  }
}
