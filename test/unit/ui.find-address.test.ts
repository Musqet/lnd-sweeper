/**
 * realPorts.findAddress and masterXprv: locate a known wallet address by local
 * derivation (no chain lookups), and export the root xprv for import elsewhere.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { realPorts } from "../../src/ui/adapters";
import { deriveAddress, masterFromEntropy, rootXprv } from "../../src/keys";
import { branchFor } from "../../src/keys";
import type { CipherSeed, Network } from "../../src/types";
import { loadVectors } from "./keys-fixtures";

const entropy = hexToBytes(loadVectors()[0]!.entropy_hex);
const seed: CipherSeed = { internalVersion: 0, birthdayDays: 0, entropy, salt: new Uint8Array(5) };

/** The exact address this seed derives at a given branch/index, via the derivation the tool uses. */
function addressAt(network: Network, kind: "p2tr" | "p2wkh" | "np2wkh", change: 0 | 1, index: number): string {
  return deriveAddress(masterFromEntropy(entropy), network, branchFor(kind, change), index).address;
}

describe("findAddress", () => {
  it("locates a Taproot receive address on m/86' past the baseline gap", async () => {
    const target = addressAt("mainnet", "p2tr", 0, 213);
    const res = await realPorts.findAddress({ seed, network: "mainnet", target, maxIndex: 500 });
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.owner.address).toBe(target);
      expect(res.owner.path).toBe("m/86'/0'/0'/0/213");
      expect(res.owner.kind).toBe("p2tr");
    }
  });

  it("locates a change address on the internal branch", async () => {
    const target = addressAt("mainnet", "p2wkh", 1, 37);
    const res = await realPorts.findAddress({ seed, network: "mainnet", target, maxIndex: 100 });
    expect(res.found && res.owner.path).toBe("m/84'/0'/0'/1/37");
  });

  it("reports progress and can be cancelled", async () => {
    const seen: number[] = [];
    const ctrl = new AbortController();
    // Target beyond the first 1024-address chunk so a progress event fires (and aborts) before it is found.
    const target = addressAt("mainnet", "p2tr", 0, 1500);
    const p = realPorts.findAddress({ seed, network: "mainnet", target, maxIndex: 2000, signal: ctrl.signal, onProgress: (s) => { seen.push(s); if (s > 0) ctrl.abort(); } });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("rejects an address type lnd's wallet never derives (P2WSH)", async () => {
    // A valid mainnet P2WSH address (32-byte v0 program).
    const res = await realPorts.findAddress({ seed, network: "mainnet", target: "bc1q4l7yry66wsxye5tqeqtc6zk89zdeg0ymz4jerdz90yd4hmf9cylshhya3x", maxIndex: 10 });
    expect(res).toMatchObject({ found: false, reason: "not-wallet-kind" });
  });

  it("rejects an invalid address", async () => {
    const res = await realPorts.findAddress({ seed, network: "mainnet", target: "not-an-address", maxIndex: 10 });
    expect(res).toMatchObject({ found: false, reason: "invalid" });
  });

  it("returns exhausted when the index is not reached", async () => {
    const target = addressAt("mainnet", "p2tr", 0, 4213);
    const res = await realPorts.findAddress({ seed, network: "mainnet", target, maxIndex: 50 });
    expect(res).toMatchObject({ found: false, reason: "exhausted" });
  });

  it("does not match a mainnet address when scanning testnet", async () => {
    const target = addressAt("mainnet", "p2tr", 0, 5);
    const res = await realPorts.findAddress({ seed, network: "testnet", target, maxIndex: 50 });
    // Different network encoding, so validateDestination rejects it outright.
    expect(res.found).toBe(false);
  });
});

describe("masterXprv", () => {
  it("returns the root xprv the derivation uses", () => {
    expect(realPorts.masterXprv(seed, "mainnet")).toBe(rootXprv(entropy, "mainnet"));
    expect(realPorts.masterXprv(seed, "mainnet").startsWith("xprv")).toBe(true);
  });
});
