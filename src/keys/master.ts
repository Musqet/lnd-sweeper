/**
 * BIP32 master key from aezeed entropy.
 *
 * lnd feeds the 16 raw entropy bytes of the cipherseed straight into
 * hdkeychain.NewMaster (no BIP39 stretching), so the master seed is the
 * entropy itself.
 */
import { HDKey } from "@scure/bip32";
import type { Network } from "../types";

export const AEZEED_ENTROPY_BYTES = 16;

/** Build the BIP32 root node from the 16-byte aezeed entropy. */
export function masterFromEntropy(entropy: Uint8Array): HDKey {
  if (!(entropy instanceof Uint8Array) || entropy.length !== AEZEED_ENTROPY_BYTES) {
    throw new Error(`aezeed entropy must be ${AEZEED_ENTROPY_BYTES} bytes`);
  }
  return HDKey.fromMasterSeed(entropy);
}

/**
 * Base58 root extended private key, as chantools prints it.
 *
 * chantools shows the mainnet `xprv` serialisation for every network, so the
 * network argument does not change the output; it is kept so callers state
 * which network they are working on and so the signature can grow a
 * network-specific serialisation later without churn. Only for test
 * comparison and debugging: never log the result.
 */
export function rootXprv(entropy: Uint8Array, _network: Network): string {
  return masterFromEntropy(entropy).privateExtendedKey;
}
