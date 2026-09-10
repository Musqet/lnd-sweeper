/**
 * Transaction history for the optional "show transactions" panel.
 * Fetches every tx touching the used addresses, de-duplicates across
 * addresses, and works out the net effect on the wallet per tx.
 */
import type { AddressTx, ChainClient, DerivedAddress } from "../types";

export interface OwnedTx extends AddressTx {
  /** Net effect on the address set, satoshis. Positive is incoming. */
  netSats: number;
  /** Our addresses this tx pays to or spends from, sorted. */
  ownAddresses: string[];
}

export interface FetchTransactionsOptions {
  signal?: AbortSignal;
}

/** Net effect of `tx` on the address set: outputs to us minus inputs from us. */
export function netAmount(tx: AddressTx, own: ReadonlySet<string>): number {
  let net = 0;
  for (const o of tx.vout) if (o.address !== undefined && own.has(o.address)) net += o.value;
  for (const i of tx.vin) if (i.address !== undefined && own.has(i.address) && i.value !== undefined) net -= i.value;
  return net;
}

export function ownAddressesOf(tx: AddressTx, own: ReadonlySet<string>): string[] {
  const set = new Set<string>();
  for (const o of tx.vout) if (o.address !== undefined && own.has(o.address)) set.add(o.address);
  for (const i of tx.vin) if (i.address !== undefined && own.has(i.address)) set.add(i.address);
  return [...set].sort();
}

/** Newest first: unconfirmed, then by block height descending, then txid for stability. */
export function compareTxs(a: AddressTx, b: AddressTx): number {
  const ha = a.status.confirmed ? (a.status.blockHeight ?? 0) : Number.POSITIVE_INFINITY;
  const hb = b.status.confirmed ? (b.status.blockHeight ?? 0) : Number.POSITIVE_INFINITY;
  if (ha !== hb) return hb > ha ? 1 : -1;
  return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
}

/**
 * All transactions touching any of `addresses`, once each, newest first.
 * Lookups run concurrently; the client's limiter bounds them.
 */
export async function fetchTransactions(
  client: ChainClient,
  addresses: readonly (DerivedAddress | string)[],
  options: FetchTransactionsOptions = {},
): Promise<OwnedTx[]> {
  const own = new Set<string>(addresses.map((a) => (typeof a === "string" ? a : a.address)));
  const unique = [...own].sort();
  const byTxid = new Map<string, AddressTx>();
  const lists = await Promise.all(
    unique.map(async (addr) => {
      throwIfAborted(options.signal);
      return client.getAddressTxs(addr);
    }),
  );
  for (const list of lists) {
    for (const tx of list) {
      const prior = byTxid.get(tx.txid);
      // Prefer a confirmed view if the same tx shows up unconfirmed elsewhere (race between requests).
      if (!prior || (!prior.status.confirmed && tx.status.confirmed)) byTxid.set(tx.txid, tx);
    }
  }
  return [...byTxid.values()]
    .sort(compareTxs)
    .map((tx) => ({ ...tx, netSats: netAmount(tx, own), ownAddresses: ownAddressesOf(tx, own) }));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const e = new Error("Aborted");
    e.name = "AbortError";
    throw e;
  }
}
