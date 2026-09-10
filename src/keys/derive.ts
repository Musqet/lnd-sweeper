/**
 * Wallet address derivation for lnd's on-chain wallet branches.
 *
 *   m/49'/coin'/0'/0/i  np2wkh  P2SH-wrapped P2WPKH   (btcwallet KeyScopeBIP0049Plus, external)
 *   m/49'/coin'/0'/1/i  p2wkh   native P2WPKH         (BIP0049Plus INTERNAL branch is native segwit)
 *   m/84'/coin'/0'/c/i  p2wkh   P2WPKH
 *   m/86'/coin'/0'/c/i  p2tr    P2TR, BIP86 key path (BIP341 tweak, no script tree)
 *
 * The derivation path is fixed by (purpose, coin, change, index); the script
 * type is a separate property of the Branch (types.ts WALLET_BRANCHES), so the
 * same key can be encoded two ways (49/1 as p2wkh is what lnd does; 49/1 as
 * np2wkh is a belt-and-braces extra branch).
 *
 * lnd's wallet (btcwallet waddrmgr) derives every level with btcd's
 * hdkeychain.DeriveNonStandard, which is NOT BIP32 at hardened levels: the
 * parent private key is serialised as a minimal big-endian integer
 * (big.Int.Bytes(), no left padding) and copied into data[1:], so a parent key
 * with leading zero bytes is effectively right-padded. About 1.9% of seeds have
 * such a key at m/purpose' or m/purpose'/coin', and for those every address of
 * that purpose differs from standard BIP32. We emulate btcd exactly at the
 * coin' and account' levels. The purpose' level is standard because
 * hdkeychain.NewMaster stores the full 32-byte HMAC output as the master key,
 * and non-hardened levels are standard because they serialise the public key.
 *
 * The account node (m/purpose'/coin'/0') and each branch node are cached per
 * master key so a deep scan costs one non-hardened child derivation plus
 * address encoding per index. Address-only derivation is done from public-only
 * branch nodes so no private key material is created for it.
 */
import { HARDENED_OFFSET, HDKey } from "@scure/bip32";
import { NETWORK, TEST_NETWORK, p2sh, p2tr, p2wpkh } from "@scure/btc-signer";
import type { BTC_NETWORK } from "@scure/btc-signer/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { WeierstrassPoint } from "@noble/curves/abstract/weierstrass.js";
import { bytesToNumberBE, numberToBytesBE, numberToVarBytesBE } from "@noble/curves/utils.js";
import {
  EXTRA_BRANCHES,
  PURPOSE_FOR_KIND,
  WALLET_BRANCHES,
  branchKey,
  coinTypeFor,
  type AddressKind,
  type Branch,
  type DerivedAddress,
  type DerivedKey,
  type Network,
  type Purpose,
} from "../types";

export type Change = 0 | 1;

export interface DeriveOptions {
  /**
   * Override the BIP44 coin type. Defaults to `coinTypeFor(network)`, which is
   * 0 on every network because lnd's wallet key scopes (btcwallet waddrmgr)
   * hardcode coin 0. Scanners pass 1 for the belt-and-braces pass off mainnet
   * (see `walletCoinTypesFor`).
   */
  coinType?: 0 | 1;
  /**
   * Accept a Branch that is not in WALLET_BRANCHES or EXTRA_BRANCHES (for
   * example {purpose: 84, kind: "np2wkh"}). Such branches never hold lnd funds;
   * this is for debugging tooling only and must not be set by the scanner or
   * the UI.
   */
  allowAnyBranch?: boolean;
}

const CURVE_ORDER = secp256k1.Point.Fn.ORDER;
const REGTEST_NETWORK: BTC_NETWORK = Object.freeze({ ...TEST_NETWORK, bech32: "bcrt" });
const NETWORKS: readonly Network[] = ["mainnet", "testnet", "signet", "regtest"];
const PURPOSES: readonly Purpose[] = [49, 84, 86];

// ---------------------------------------------------------------------------
// Runtime guards: JS callers bypass the TypeScript types.

function assertNetwork(network: Network): void {
  if (!NETWORKS.includes(network)) throw new TypeError(`unknown network ${String(network)}`);
}

function assertKind(kind: AddressKind): void {
  if (!Object.hasOwn(PURPOSE_FOR_KIND, kind)) throw new TypeError(`unknown address kind ${String(kind)}`);
}

function assertPurpose(purpose: Purpose): void {
  if (!PURPOSES.includes(purpose)) throw new RangeError(`purpose must be 49, 84 or 86, got ${String(purpose)}`);
}

function assertChange(change: Change): void {
  if (change !== 0 && change !== 1) throw new RangeError("change must be 0 (external) or 1 (internal)");
}

const KNOWN_BRANCHES: ReadonlySet<string> = new Set([...WALLET_BRANCHES, ...EXTRA_BRANCHES].map(branchKey));

function assertBranch(branch: Branch, opts?: DeriveOptions): void {
  if (typeof branch !== "object" || branch === null) throw new TypeError("branch must be a Branch object");
  assertPurpose(branch.purpose);
  assertChange(branch.change);
  assertKind(branch.kind);
  if (opts?.allowAnyBranch === true) return;
  if (!KNOWN_BRANCHES.has(branchKey(branch))) {
    throw new RangeError(
      `branch ${branchKey(branch)} is not one lnd's wallet uses (WALLET_BRANCHES or EXTRA_BRANCHES); ` +
        "pass allowAnyBranch for debugging tooling only",
    );
  }
}

function assertCoinType(coinType: unknown): asserts coinType is 0 | 1 {
  if (coinType !== 0 && coinType !== 1) throw new RangeError("coinType must be 0 or 1");
}

function checkIndex(index: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new RangeError(`${what} must be a non-hardened BIP32 index`);
  }
}

// ---------------------------------------------------------------------------
// Networks and paths.

/** @scure/btc-signer network parameters for an lnd network. */
export function btcNetworkFor(network: Network): BTC_NETWORK {
  switch (network) {
    case "mainnet":
      return NETWORK;
    case "testnet":
    case "signet":
      return TEST_NETWORK;
    case "regtest":
      return REGTEST_NETWORK;
    default:
      throw new TypeError(`unknown network ${String(network)}`);
  }
}

function resolveCoinType(network: Network, opts?: DeriveOptions): 0 | 1 {
  const coinType = opts?.coinType ?? coinTypeFor(network);
  assertCoinType(coinType);
  return coinType;
}

/** Account path m/purpose'/coin'/0' on a network. */
export function accountPath(network: Network, purpose: Purpose, opts?: DeriveOptions): string {
  assertNetwork(network);
  assertPurpose(purpose);
  return `m/${purpose}'/${resolveCoinType(network, opts)}'/0'`;
}

/** Full address path m/purpose'/coin'/0'/change/index. */
export function addressPath(
  network: Network,
  purpose: Purpose,
  change: Change,
  index: number,
  opts?: DeriveOptions,
): string {
  assertChange(change);
  checkIndex(index, "index");
  return `${accountPath(network, purpose, opts)}/${change}/${index}`;
}

/**
 * Branch for a script kind on the external or internal chain, using the
 * kind's default purpose (49 for np2wkh, 84 for p2wkh, 86 for p2tr). Note
 * branchFor("np2wkh", 1) is the belt-and-braces EXTRA branch, not what lnd
 * produces: lnd encodes m/49'/…/1/i as p2wkh (WALLET_BRANCHES).
 */
export function branchFor(kind: AddressKind, change: Change): Branch {
  assertKind(kind);
  assertChange(change);
  return { purpose: PURPOSE_FOR_KIND[kind], change, kind };
}

// ---------------------------------------------------------------------------
// BIP32 arithmetic. Every level is computed here rather than with
// HDKey.deriveChild: @scure retries at index+1 when IL >= n, whereas btcd
// (and so lnd) errors. Retrying would silently return the next index labelled
// as the requested one, so we throw instead.

/**
 * IL of an HMAC-SHA512 output as a scalar. Throws RangeError where BIP32 says
 * "retry" and btcd returns ErrInvalidChild (probability about 2^-127).
 */
export function childTweak(I: Uint8Array): bigint {
  if (I.length !== 64) throw new RangeError("expected a 64-byte HMAC-SHA512 output");
  const il = bytesToNumberBE(I.subarray(0, 32));
  if (il === 0n || il >= CURVE_ORDER) {
    throw new RangeError("invalid child key (IL out of range); this index is unusable");
  }
  return il;
}

/** Runs the child HMAC, consumes and zeroes `data`, returns IL and the child chain code. */
function hmacChild(chainCode: Uint8Array, data: Uint8Array): { il: bigint; chainCode: Uint8Array } {
  const I = hmac(sha512, chainCode, data);
  try {
    const il = childTweak(I);
    return { il, chainCode: Uint8Array.from(I.subarray(32)) };
  } finally {
    I.fill(0);
    data.fill(0);
  }
}

function childScalarBytes(il: bigint, parentPriv: Uint8Array): Uint8Array {
  const child = (il + bytesToNumberBE(parentPriv)) % CURVE_ORDER;
  if (child === 0n) throw new RangeError("invalid child key (zero); this index is unusable");
  return numberToBytesBE(child, 32);
}

/**
 * Hardened child of a private HDKey. `minimalParentKey` selects btcd's
 * DeriveNonStandard serialisation of the parent key (big.Int.Bytes(), no
 * left padding, right-padded to 33 bytes with the leading 0x00) versus the
 * padded 32-byte serialisation btcd uses for a key that came from NewMaster.
 */
function hardenedChild(parent: HDKey, childIndex: number, minimalParentKey: boolean): HDKey {
  if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex >= HARDENED_OFFSET) {
    throw new RangeError("hardened child index must be in 0..2^31-1");
  }
  const parentPriv = parent.privateKey;
  const parentChainCode = parent.chainCode;
  if (!parentPriv || !parentChainCode) throw new Error("hardened derivation needs a private parent");
  const index = childIndex + HARDENED_OFFSET;
  let privateKey: Uint8Array | undefined;
  try {
    const data = new Uint8Array(37); // 0x00 || key || index
    if (minimalParentKey) {
      const minimal = numberToVarBytesBE(bytesToNumberBE(parentPriv));
      data.set(minimal, 1);
      minimal.fill(0);
    } else {
      data.set(parentPriv, 1);
    }
    new DataView(data.buffer).setUint32(33, index, false);
    const { il, chainCode } = hmacChild(parentChainCode, data);
    privateKey = childScalarBytes(il, parentPriv);
    return new HDKey({
      versions: parent.versions,
      depth: parent.depth + 1,
      index,
      parentFingerprint: parent.fingerprint,
      chainCode,
      privateKey,
    });
  } finally {
    parentPriv.fill(0);
    privateKey?.fill(0);
  }
}

/**
 * Hardened child exactly as btcd's ExtendedKey.DeriveNonStandard computes it
 * when the parent itself came from DeriveNonStandard (minimal parent key).
 * Identical to BIP32 when the parent key has no leading zero byte.
 */
export function deriveHardenedNonStandard(parent: HDKey, childIndex: number): HDKey {
  return hardenedChild(parent, childIndex, true);
}

/**
 * Standard BIP32 hardened child (padded parent key), as btcd computes the
 * purpose' step from a NewMaster key. Unlike HDKey.deriveChild it throws on a
 * bad IL instead of retrying.
 */
export function deriveHardenedStandard(parent: HDKey, childIndex: number): HDKey {
  return hardenedChild(parent, childIndex, false);
}

/** Minimal private node for the non-hardened levels. */
interface PrivateNode {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  chainCode: Uint8Array;
}

/** Standard BIP32 non-hardened private child. The returned privateKey is a fresh buffer. */
function privateChild(parent: PrivateNode, index: number): PrivateNode {
  const data = new Uint8Array(37);
  data.set(parent.publicKey, 0);
  new DataView(data.buffer).setUint32(33, index, false);
  const { il, chainCode } = hmacChild(parent.chainCode, data);
  const privateKey = childScalarBytes(il, parent.privateKey);
  try {
    return { privateKey, publicKey: secp256k1.getPublicKey(privateKey, true), chainCode };
  } catch (e) {
    privateKey.fill(0);
    throw e;
  }
}

/**
 * Account node m/purpose'/coin'/account' the way btcwallet derives it:
 * purpose' from the 32-byte master key (standard), coin' and account' with
 * DeriveNonStandard's minimal parent-key serialisation.
 */
function deriveAccountNonStandard(master: HDKey, purpose: number, coinType: number, account: number): HDKey {
  const purposeNode = deriveHardenedStandard(master, purpose);
  try {
    const coinNode = deriveHardenedNonStandard(purposeNode, coinType);
    try {
      return deriveHardenedNonStandard(coinNode, account);
    } finally {
      coinNode.wipePrivateData();
    }
  } finally {
    purposeNode.wipePrivateData();
  }
}

// ---------------------------------------------------------------------------
// Node cache.

/** Public-only view of a branch node, with the parent point decompressed once. */
interface PublicBranch {
  point: WeierstrassPoint<bigint>;
  publicKey: Uint8Array;
  chainCode: Uint8Array;
}

interface BranchNodes {
  /** Private branch node, used only by deriveKey. */
  priv: PrivateNode;
  /** Public-only branch, used for address derivation (no private material). */
  pub: PublicBranch;
}

/**
 * Standard BIP32 non-hardened public child: point(parent) + IL*G. Same result
 * as HDKey.deriveChild on a public-only node, without re-decompressing the
 * parent point for every index.
 */
function publicChild(branch: PublicBranch, index: number): Uint8Array {
  const data = new Uint8Array(37);
  data.set(branch.publicKey, 0);
  new DataView(data.buffer).setUint32(33, index, false);
  const I = hmac(sha512, branch.chainCode, data);
  const il = childTweak(I);
  const child = branch.point.add(secp256k1.Point.BASE.multiply(il));
  if (child.is0()) throw new RangeError("invalid child key (point at infinity); this index is unusable");
  return child.toBytes(true);
}

interface MasterCache {
  accounts: Map<string, HDKey>;
  branches: Map<string, BranchNodes>;
}

const nodeCache = new WeakMap<HDKey, MasterCache>();

function cacheFor(master: HDKey): MasterCache {
  let c = nodeCache.get(master);
  if (!c) {
    c = { accounts: new Map(), branches: new Map() };
    nodeCache.set(master, c);
  }
  return c;
}

/** Account-level node m/purpose'/coin'/0' (private). */
export function accountNode(master: HDKey, network: Network, purpose: Purpose, opts?: DeriveOptions): HDKey {
  const path = accountPath(network, purpose, opts);
  const cache = cacheFor(master);
  let node = cache.accounts.get(path);
  if (!node) {
    if (!master.privateKey) throw new Error("master key has no private key");
    node = deriveAccountNonStandard(master, purpose, resolveCoinType(network, opts), 0);
    cache.accounts.set(path, node);
  }
  return node;
}

/** Account-level xpub (mainnet version bytes, like lnd and chantools print). For debugging. */
export function accountXpub(master: HDKey, network: Network, purpose: Purpose, opts?: DeriveOptions): string {
  return accountNode(master, network, purpose, opts).publicExtendedKey;
}

/** Branch nodes are keyed by path only: the script kind does not affect derivation. */
function branchNodes(
  master: HDKey,
  network: Network,
  purpose: Purpose,
  change: Change,
  opts?: DeriveOptions,
): BranchNodes {
  assertChange(change);
  const path = `${accountPath(network, purpose, opts)}/${change}`;
  const cache = cacheFor(master);
  let nodes = cache.branches.get(path);
  if (!nodes) {
    const account = accountNode(master, network, purpose, opts);
    const accountPriv = account.privateKey;
    const accountPub = account.publicKey;
    const accountChainCode = account.chainCode;
    if (!accountPriv || !accountPub || !accountChainCode) throw new Error("account node is incomplete");
    let priv: PrivateNode;
    try {
      priv = privateChild({ privateKey: accountPriv, publicKey: accountPub, chainCode: accountChainCode }, change);
    } finally {
      accountPriv.fill(0);
    }
    nodes = {
      priv,
      pub: { point: secp256k1.Point.fromBytes(priv.publicKey), publicKey: priv.publicKey, chainCode: priv.chainCode },
    };
    cache.branches.set(path, nodes);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Address encoding.

/** Address and output script for a compressed public key. */
export function addressFor(
  publicKey: Uint8Array,
  network: Network,
  kind: AddressKind,
): { address: string; scriptPubKey: Uint8Array } {
  assertKind(kind);
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 33) {
    throw new Error("expected a 33-byte compressed public key");
  }
  const net = btcNetworkFor(network);
  switch (kind) {
    case "np2wkh": {
      const p = p2sh(p2wpkh(publicKey, net), net);
      return { address: p.address!, scriptPubKey: p.script };
    }
    case "p2wkh": {
      const p = p2wpkh(publicKey, net);
      return { address: p.address!, scriptPubKey: p.script };
    }
    case "p2tr": {
      // BIP86: internal key is the x-only pubkey, tweaked with an empty script tree.
      const p = p2tr(publicKey.subarray(1), undefined, net);
      return { address: p.address!, scriptPubKey: p.script };
    }
  }
}

function toAddress(
  publicKey: Uint8Array,
  network: Network,
  branch: Branch,
  index: number,
  opts: DeriveOptions | undefined,
): DerivedAddress {
  const { address, scriptPubKey } = addressFor(publicKey, network, branch.kind);
  return {
    kind: branch.kind,
    purpose: branch.purpose,
    network,
    path: addressPath(network, branch.purpose, branch.change, index, opts),
    change: branch.change,
    index,
    address,
    publicKey,
    scriptPubKey,
  };
}

// ---------------------------------------------------------------------------
// Public API. The scanner iterates WALLET_BRANCHES (then EXTRA_BRANCHES) from
// types.ts; a Branch fixes the path (purpose, change) and the script kind.

/**
 * Derive one address on a branch with its signing key. The private key is a
 * fresh buffer owned by the caller, who must zero it after use (the only other
 * copy of the scalar is a transient bigint, which cannot be zeroed). Never log
 * the result.
 */
export function deriveKey(
  master: HDKey,
  network: Network,
  branch: Branch,
  index: number,
  opts?: DeriveOptions,
): DerivedKey {
  assertBranch(branch, opts);
  checkIndex(index, "index");
  const child = privateChild(branchNodes(master, network, branch.purpose, branch.change, opts).priv, index);
  try {
    return { ...toAddress(child.publicKey, network, branch, index, opts), privateKey: child.privateKey };
  } catch (e) {
    child.privateKey.fill(0);
    throw e;
  }
}

/** Derive one address on a branch without creating any private key material. */
export function deriveAddress(
  master: HDKey,
  network: Network,
  branch: Branch,
  index: number,
  opts?: DeriveOptions,
): DerivedAddress {
  assertBranch(branch, opts);
  checkIndex(index, "index");
  const publicKey = publicChild(branchNodes(master, network, branch.purpose, branch.change, opts).pub, index);
  return toAddress(publicKey, network, branch, index, opts);
}

/** Derive `count` consecutive addresses on a branch, starting at `start`. Public-only. */
export function deriveBranchAddresses(
  master: HDKey,
  network: Network,
  branch: Branch,
  start: number,
  count: number,
  opts?: DeriveOptions,
): DerivedAddress[] {
  assertBranch(branch, opts);
  checkIndex(start, "start");
  if (!Number.isInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
  const nodes = branchNodes(master, network, branch.purpose, branch.change, opts); // validates the rest
  if (count === 0) return [];
  checkIndex(start + count - 1, "start + count - 1");
  const out: DerivedAddress[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const index = start + i;
    out[i] = toAddress(publicChild(nodes.pub, index), network, branch, index, opts);
  }
  return out;
}

/** Convenience: address by script kind on the kind's default purpose (see branchFor). */
export function deriveAddressByKind(
  master: HDKey,
  network: Network,
  kind: AddressKind,
  change: Change,
  index: number,
  opts?: DeriveOptions,
): DerivedAddress {
  return deriveAddress(master, network, branchFor(kind, change), index, opts);
}
