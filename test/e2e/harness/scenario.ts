/**
 * The funding scenario shared by the e2e test and scripts/e2e-up.sh:
 * several addresses of each kind at non-sequential indices, funded with
 * distinct amounts, then spends from each address type so real change lands
 * on the internal branches of the BIP84 and BIP86 paths.
 */
import type { AddressKind } from "../../../src/types";
import type { Bitcoind } from "./bitcoind";
import type { Lnd, LndUtxo } from "./lnd";
import { waitFor } from "./util";

export const KINDS: readonly AddressKind[] = ["p2wkh", "np2wkh", "p2tr"];
/** External-branch indices funded on each path; the gaps prove the scan copes with unused addresses. */
export const FUNDED_INDICES: readonly number[] = [0, 2, 5];
export const ADDRESSES_PER_KIND = 6;

export interface Funded {
  kind: AddressKind;
  index: number;
  address: string;
  sats: number;
  txid: string;
}

export interface FundingResult {
  /** Every external address lnd handed out, per kind, in index order. */
  externalAddresses: Record<AddressKind, string[]>;
  funded: Funded[];
  fundedTotalSats: number;
  /**
   * Scenario D: addresses from WalletKit.NextAddr(NESTED_WITNESS_PUBKEY_HASH, change=true),
   * i.e. m/49'/0'/0'/1/i encoded as native P2WPKH (btcwallet BIP0049Plus). Funded directly.
   */
  nestedChange: Funded[];
}

export interface SpendResult {
  spentBackSats: number;
  /** lnd's own view after the spends confirmed. */
  lndUtxos: LndUtxo[];
  lndConfirmedSats: number;
  /** Addresses holding UTXOs that were not funded directly: lnd's change. */
  changeAddresses: string[];
}

export type Scenario = FundingResult & SpendResult;

/** Hand out ADDRESSES_PER_KIND addresses per kind, fund FUNDED_INDICES of each, mine, wait for lnd. */
export async function fundLnd(bd: Bitcoind, lnd: Lnd, opts: { nestedChangeCount?: number } = {}): Promise<FundingResult> {
  const externalAddresses: Record<AddressKind, string[]> = { p2wkh: [], np2wkh: [], p2tr: [] };
  const funded: Funded[] = [];
  const nestedChange: Funded[] = [];
  let fundedTotalSats = 0;
  let amountCounter = 0;
  for (const kind of KINDS) {
    const addrs: string[] = [];
    for (let i = 0; i < ADDRESSES_PER_KIND; i++) addrs.push(await lnd.newAddress(kind));
    externalAddresses[kind] = addrs;
    for (const index of FUNDED_INDICES) {
      // Distinct amounts so a wrong value in a recovered set cannot cancel out.
      const sats = 1_000_000 + 10_000 * ++amountCounter + index;
      const address = addrs[index]!;
      const txid = await bd.sendTo(address, sats / 1e8);
      funded.push({ kind, index, address, sats, txid });
      fundedTotalSats += sats;
    }
  }
  for (let index = 0; index < (opts.nestedChangeCount ?? 0); index++) {
    const address = await lnd.nextAddr("np2wkh", true);
    const sats = 700_000 + 10_000 * ++amountCounter + index;
    const txid = await bd.sendTo(address, sats / 1e8);
    nestedChange.push({ kind: "p2wkh", index, address, sats, txid });
    fundedTotalSats += sats;
  }
  await bd.mine(1);
  await lnd.waitSynced();
  await waitFor(
    "lnd to see the funding",
    async () => ((await lnd.walletBalance()).confirmedSat === fundedTotalSats ? true : undefined),
    { timeoutMs: 60_000 },
  );
  return { externalAddresses, funded, fundedTotalSats, nestedChange };
}

/**
 * Spend one UTXO of each kind back to bitcoind, steering change to the BIP86
 * internal branch (p2wkh and p2tr inputs) and the BIP84 internal branch
 * (np2wkh input), plus one plain SendCoins for lnd's own coin selection.
 */
export async function spendFromEachKind(bd: Bitcoind, lnd: Lnd, funding: FundingResult): Promise<SpendResult> {
  const before = await lnd.listUnspent();
  const byAddr = new Map(before.map((u) => [u.address, u]));
  const pick = (kind: AddressKind, index: number): LndUtxo => {
    const f = funding.funded.find((x) => x.kind === kind && x.index === index);
    const u = f && byAddr.get(f.address);
    if (!u) throw new Error(`lnd has no utxo for ${kind}/${index}`);
    return u;
  };

  const a = pick("p2wkh", 0);
  const sendA = Math.floor(a.amountSat * 0.4);
  await lnd.spendUtxos([{ txid: a.txid, vout: a.vout }], await bd.newAddress(), sendA, "p2tr");
  const b = pick("np2wkh", 2);
  const sendB = Math.floor(b.amountSat * 0.35);
  await lnd.spendUtxos([{ txid: b.txid, vout: b.vout }], await bd.newAddress("bech32m"), sendB, "p2wkh");
  const c = pick("p2tr", 5);
  const sendC = Math.floor(c.amountSat * 0.3);
  await lnd.spendUtxos([{ txid: c.txid, vout: c.vout }], await bd.newAddress("p2sh-segwit"), sendC, "p2tr");
  const sendD = 123_456;
  await lnd.sendCoins(await bd.newAddress("legacy"), sendD, 2);
  const spentBackSats = sendA + sendB + sendC + sendD;

  await bd.mine(1);
  await lnd.waitSynced();
  await waitFor("lnd to confirm the spends", async () =>
    (await lnd.walletBalance()).unconfirmedSat === 0 ? true : undefined,
  );

  const lndUtxos = await lnd.listUnspent();
  const lndConfirmedSats = (await lnd.walletBalance()).confirmedSat;
  const fundedSet = new Set([...funding.funded, ...funding.nestedChange].map((f) => f.address));
  const changeAddresses = lndUtxos.filter((u) => !fundedSet.has(u.address)).map((u) => u.address);
  return { spentBackSats, lndUtxos, lndConfirmedSats, changeAddresses };
}

export async function runScenario(bd: Bitcoind, lnd: Lnd): Promise<Scenario> {
  const funding = await fundLnd(bd, lnd, { nestedChangeCount: 2 });
  const spends = await spendFromEachKind(bd, lnd, funding);
  return { ...funding, ...spends };
}
