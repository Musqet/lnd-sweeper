/**
 * Recovery-side glue shared by the e2e suites: how the tests drive src/keys,
 * src/chain and src/tx from a master key. Nothing here talks to lnd; the
 * recovery path only ever sees the words, the passphrase and the shim.
 */
import type { HDKey } from "@scure/bip32";
import type { AddressKind, Branch, DerivedAddress, DerivedKey, Network, Purpose } from "../../../src/types";
import { deriveAddress, deriveKey } from "../../../src/keys";
import { EsploraClient, type Deriver } from "../../../src/chain";
import type { Shim } from "../esplora-shim";
import type { ChantoolsAddresses } from "./chantools";

export const NETWORK: Network = "regtest";

/** Kind whose chantools run covers a purpose (chantools is driven per derivation path). */
export const KIND_FOR_PURPOSE: Record<Purpose, AddressKind> = { 49: "np2wkh", 84: "p2wkh", 86: "p2tr" };

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Sorted "txid:vout=value" strings, for exact UTXO-set comparison across lnd's and our views. */
export const outpoints = (u: { txid: string; vout: number; value?: number; amountSat?: number }[]): string[] =>
  u.map((x) => `${x.txid}:${x.vout}=${x.value ?? x.amountSat}`).sort();

/** Coin type an address was derived under, read back from its path (m/purpose'/coin'/...). */
export function coinTypeOfPath(path: string): 0 | 1 {
  const m = /^m\/\d+'\/(\d+)'/.exec(path);
  if (!m) throw new Error(`unrecognised path ${path}`);
  return m[1] === "0" ? 0 : 1;
}

export const branchOf = (a: DerivedAddress): Branch => ({ purpose: a.purpose, change: a.change, kind: a.kind });

export const branchLabel = (b: Branch): `${Purpose}/${0 | 1}/${AddressKind}` => `${b.purpose}/${b.change}/${b.kind}`;

export const deriverFor =
  (master: HDKey, network: Network = NETWORK): Deriver =>
  (coinType, branch, index) =>
    deriveAddress(master, network, branch, index, { coinType });

/** Signer callback: a fresh DerivedKey per call (signSweep zeroes each one after use). */
export const keyFor =
  (master: HDKey, network: Network = NETWORK) =>
  (owner: DerivedAddress): DerivedKey =>
    deriveKey(master, network, branchOf(owner), owner.index, { coinType: coinTypeOfPath(owner.path) });

/**
 * Rate the tests run the client at. The client's default pacer (8 requests/s) is
 * for public Esplora instances; against the local shim it would turn a 35,000
 * request tier-2500 scan into 73 minutes. Tests assert the shim, not the pacer,
 * bounds runtime (see the tier tests).
 */
export const TEST_RATE_PER_SECOND = 10_000;

export const clientFor = (shim: Shim, opts: { concurrency?: number; ratePerSecond?: number } = {}): EsploraClient =>
  new EsploraClient(shim.baseUrl, {
    network: NETWORK,
    concurrency: opts.concurrency ?? 8,
    ratePerSecond: opts.ratePerSecond ?? TEST_RATE_PER_SECOND,
  });

/** Run `fn` and report wall time plus how many HTTP requests the shim served meanwhile. */
export async function measured<T>(shim: Shim, fn: () => Promise<T>): Promise<{ result: T; ms: number; requests: number }> {
  const r0 = shim.requests;
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0, requests: shim.requests - r0 };
}

/** Lowest-target fee estimate the client reports (what a UI would offer as "fast"). */
export async function fastestFeeRate(client: EsploraClient): Promise<number> {
  const est = await client.getFeeEstimates();
  const fastest = Object.entries(est)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((x, y) => x[0] - y[0])[0];
  return fastest?.[1] ?? 0;
}

/** chantools' addresses for a branch, in that branch's script encoding. */
export function chantoolsBranch(ct: ChantoolsAddresses, b: Branch): string[] {
  const perPath = ct[KIND_FOR_PURPOSE[b.purpose]];
  return (b.change === 0 ? perPath.encodings.external : perPath.encodings.internal)[b.kind];
}
