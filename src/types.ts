/**
 * Shared contracts between the independent pieces of lnd-sweeper.
 * Keep this file small and stable; every module imports from here.
 * Changing a type here is a cross-team change: do it deliberately.
 */

/** Bitcoin networks lnd can run on. */
export type Network = "mainnet" | "testnet" | "signet" | "regtest";

/**
 * The three output script types lnd's wallet has ever paid to. `kind` is always
 * the SCRIPT type of an address, which is what the signer needs; it is not the
 * same thing as the BIP purpose of the path (see Branch below).
 */
export type AddressKind = "np2wkh" | "p2wkh" | "p2tr";

/** BIP purpose of a wallet key scope. */
export type Purpose = 49 | 84 | 86;

/**
 * One scanned branch: a purpose, an external/internal flag, and the script
 * type lnd encodes keys on that branch as.
 *
 * lnd's wallet is btcwallet. Its BIP49 scope is "BIP0049Plus": external
 * addresses are nested P2WPKH, but the INTERNAL (change) branch of m/49' is
 * encoded as native P2WPKH (waddrmgr/scoped_manager.go, KeyScopeBIP0049Plus
 * schema: ExternalAddrType NestedWitnessPubKey, InternalAddrType WitnessPubKey).
 * lnd's own seed recovery scans it that way. Missing this loses funds.
 */
export interface Branch {
  purpose: Purpose;
  change: 0 | 1;
  kind: AddressKind;
}

/** The six branches lnd's wallet actually uses. Scan all of them. */
export const WALLET_BRANCHES: readonly Branch[] = [
  { purpose: 49, change: 0, kind: "np2wkh" },
  { purpose: 49, change: 1, kind: "p2wkh" },
  { purpose: 84, change: 0, kind: "p2wkh" },
  { purpose: 84, change: 1, kind: "p2wkh" },
  { purpose: 86, change: 0, kind: "p2tr" },
  { purpose: 86, change: 1, kind: "p2tr" },
];

/**
 * Belt-and-braces branches lnd never produces but other tooling (for example a
 * chantools import script, which emits every encoding for every key) could have
 * made spendable. Scanned after WALLET_BRANCHES.
 */
export const EXTRA_BRANCHES: readonly Branch[] = [
  { purpose: 49, change: 1, kind: "np2wkh" },
];

/** Stable key for per-branch records, e.g. "49/1/p2wkh". */
export type BranchKey = `${Purpose}/${0 | 1}/${AddressKind}`;

export function branchKey(b: Branch): BranchKey {
  return `${b.purpose}/${b.change}/${b.kind}`;
}

/** Default purpose for a script kind when only the kind is known (external branches). */
export const PURPOSE_FOR_KIND: Record<AddressKind, Purpose> = {
  np2wkh: 49,
  p2wkh: 84,
  p2tr: 86,
};

/**
 * Coin type for lnd's on-chain wallet paths.
 *
 * lnd's wallet is btcwallet, whose key scopes are hardcoded as
 * KeyScopeBIP0049Plus = {49, 0}, KeyScopeBIP0084 = {84, 0}, KeyScopeBIP0086 = {86, 0}
 * (waddrmgr/scoped_manager.go). The network coin type (1 off mainnet) is only used
 * for the m/1017' node key families, which hold channel keys, not wallet funds.
 * So wallet addresses are m/purpose'/0'/0'/change/index on every network.
 *
 * The scanner may additionally scan coin type 1 off mainnet as a belt-and-braces
 * pass; that is what WALLET_COIN_TYPES_FOR returns.
 */
export const WALLET_COIN_TYPE = 0 as const;

export function coinTypeFor(_network: Network): 0 {
  return WALLET_COIN_TYPE;
}

/** Coin types worth scanning on a network, primary first. */
export function walletCoinTypesFor(network: Network): readonly (0 | 1)[] {
  return network === "mainnet" ? [0] : [0, 1];
}

/** Plaintext aezeed cipherseed, as lnd defines it. Entropy is the BIP32 master seed. */
export interface CipherSeed {
  internalVersion: number;
  /** Days since the Bitcoin genesis block (2009-01-03). */
  birthdayDays: number;
  /** 16 bytes. Used directly as the BIP32 master seed by lnd. */
  entropy: Uint8Array;
  /** 5 bytes, public. */
  salt: Uint8Array;
}

/** One address derived at m/purpose'/coin'/0'/change/index. */
export interface DerivedAddress {
  /** Script type of this address (what the signer needs). */
  kind: AddressKind;
  /** BIP purpose of the path. For m/49'/…/1/i lnd uses kind "p2wkh" with purpose 49. */
  purpose: Purpose;
  network: Network;
  /** Full path, e.g. m/84'/0'/0'/0/7 */
  path: string;
  change: 0 | 1;
  index: number;
  address: string;
  /** 33-byte compressed public key. */
  publicKey: Uint8Array;
  /** Output script for this address. */
  scriptPubKey: Uint8Array;
}

/** Same as DerivedAddress but with the signing key. Never leaves memory; never logged. */
export interface DerivedKey extends DerivedAddress {
  privateKey: Uint8Array;
}

export interface TxStatus {
  confirmed: boolean;
  blockHeight?: number;
  blockTime?: number;
}

export interface Utxo {
  txid: string;
  vout: number;
  /** Satoshis. */
  value: number;
  status: TxStatus;
}

/** A UTXO joined to the address it pays to, ready for sweeping. */
export interface OwnedUtxo extends Utxo {
  owner: DerivedAddress;
}

/** Minimal transaction view for the optional "show transactions" panel. */
export interface AddressTx {
  txid: string;
  status: TxStatus;
  fee: number;
  /** Net effect on the scanned address set, satoshis, positive is incoming. */
  vin: { txid: string; vout: number; address?: string; value?: number }[];
  vout: { address?: string; value: number; scriptPubKey: string }[];
}

export interface AddressStats {
  /** Number of confirmed transactions touching this address. */
  chainTxCount: number;
  mempoolTxCount: number;
  fundedSats: number;
  spentSats: number;
}

/** Esplora-style chain backend. mempool.space and any Esplora instance implement this. */
export interface ChainClient {
  readonly baseUrl: string;
  readonly network: Network;
  getTipHeight(): Promise<number>;
  getAddressStats(address: string): Promise<AddressStats>;
  getAddressUtxos(address: string): Promise<Utxo[]>;
  getAddressTxs(address: string): Promise<AddressTx[]>;
  /** Map of confirmation-target blocks to sat/vB, e.g. {"1": 12.3, "3": 9.1, "6": 5.0}. */
  getFeeEstimates(): Promise<Record<string, number>>;
  /** Returns the txid on success; throws with the backend's message on rejection. */
  broadcast(rawTxHex: string): Promise<string>;
  /** Optional: drop transient state (cooldowns, rotation, give-up) before a fresh scan on a reused client. */
  reset?(): void;
}

export interface ScanProgress {
  /** 0 is lnd's real wallet scope (primary pass); 1 is the belt-and-braces pass off mainnet. */
  coinType: 0 | 1;
  branch: Branch;
  /** Indices scanned so far on this branch. */
  scanned: number;
  /** Window size for this pass. */
  window: number;
  /** Highest index seen with any history on this branch, or -1. */
  lastUsedIndex: number;
  /** Addresses with any history (used, whether or not still funded) seen on this branch so far. */
  usedCount: number;
  utxosFound: number;
  satsFound: number;
}

export interface ScanResult {
  network: Network;
  utxos: OwnedUtxo[];
  /** Every address with any history, used or funded. */
  usedAddresses: DerivedAddress[];
  totalSats: number;
  /** Per branch (WALLET_BRANCHES plus any EXTRA_BRANCHES scanned), how deep we scanned on coin type 0. */
  depth: Partial<Record<BranchKey, number>>;
  /**
   * Off mainnet only: how deep the secondary coin type 1 pass went, same keys.
   * Absent on mainnet or when the pass was skipped. Addresses and UTXOs from
   * that pass are identifiable by their path (m/purpose'/1'/...).
   */
  depthCoin1?: Partial<Record<BranchKey, number>>;
}

/** Unsigned sweep plan shown to the user before signing. */
export interface SweepPlan {
  inputs: OwnedUtxo[];
  destination: string;
  feeRateSatPerVb: number;
  /** Estimated virtual size in vbytes. */
  estimatedVsize: number;
  feeSats: number;
  outputSats: number;
}

export interface SignedSweep extends SweepPlan {
  txid: string;
  rawTxHex: string;
  /** Actual virtual size of the signed transaction. */
  vsize: number;
}
