/**
 * Destination address validation.
 *
 * This is the last gate before money leaves the user's keys, so it is written
 * from the specifications (BIP173, BIP350, base58check) rather than delegating to
 * a library that throws generic errors. Every rejection carries a plain reason.
 *
 * Accepted: P2PKH, P2SH, P2WPKH, P2WSH, P2TR on mainnet, testnet, signet, regtest.
 *
 * Deliberate divergence from Bitcoin Core's validateaddress: Core reports isvalid=true for
 * any well-formed bech32m address with witness version 1..16 and a 2..40 byte program
 * (including the 40-byte v1 vector and BIP433 pay-to-anchor), because consensus treats
 * undefined witness programs as anyone-can-spend. We refuse them. No such address type is in
 * use on Bitcoin today, so a user pasting one has almost certainly made a mistake, and coins
 * sent there could be taken by anyone or lost outright. The reason text says so plainly.
 *
 * Input is taken exactly as given: no trimming and no whitespace tolerated anywhere. This is
 * stricter than Core for base58 addresses, whose decoder skips surrounding spaces; the UI
 * trims before calling, so a stray space that reaches here is a bug worth surfacing. The
 * character set is checked on the raw ASCII before any case folding, so Unicode look-alikes
 * such as U+212A KELVIN SIGN (which String.toLowerCase() turns into 'k') are rejected as Core
 * does.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { Network } from "../types";

export type DestinationKind = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";

export type DestinationValidation =
  | { ok: true; kind: DestinationKind; scriptPubKey: Uint8Array }
  | { ok: false; reason: string };

/** Bitcoin Core dust thresholds (dustRelayFee 3 sat/vB) per output kind. */
export const DUST_SATS: Record<DestinationKind, number> = {
  p2pkh: 546,
  p2sh: 540,
  p2wpkh: 294,
  p2wsh: 330,
  p2tr: 330,
};

/** Serialised output script length in bytes per kind. */
export const SCRIPT_LEN: Record<DestinationKind, number> = {
  p2pkh: 25,
  p2sh: 23,
  p2wpkh: 22,
  p2wsh: 34,
  p2tr: 34,
};

const BECH32_HRP: Record<string, Network[]> = {
  bc: ["mainnet"],
  tb: ["testnet", "signet"],
  bcrt: ["regtest"],
};

const LEGACY_VERSION: Record<number, { kind: "p2pkh" | "p2sh"; networks: Network[] }> = {
  0x00: { kind: "p2pkh", networks: ["mainnet"] },
  0x05: { kind: "p2sh", networks: ["mainnet"] },
  0x6f: { kind: "p2pkh", networks: ["testnet", "signet", "regtest"] },
  0xc4: { kind: "p2sh", networks: ["testnet", "signet", "regtest"] },
};

function describeNetworks(networks: readonly Network[]): string {
  if (networks.length === 1) return networks[0]!;
  return `${networks.slice(0, -1).join(", ")} or ${networks[networks.length - 1]!}`;
}

function wrongNetwork(belongsTo: readonly Network[], expected: Network): DestinationValidation {
  return {
    ok: false,
    reason: `This is a ${describeNetworks(belongsTo)} address, but you are sweeping on ${expected}.`,
  };
}

// ---------------------------------------------------------------- bech32 / bech32m

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** 5-bit groups to bytes, no padding allowed beyond the spec (BIP173). */
function fromWords(words: number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5) return null; // too much padding
  if ((acc << (8 - bits)) & 0xff) return null; // non-zero padding
  return Uint8Array.from(out);
}

/** ASCII-only lower-casing. Never use String.toLowerCase() on address input. */
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : s[i]!;
  }
  return out;
}

function validateBech32(raw: string, hrpLower: string, network: Network): DestinationValidation {
  // Charset first, on the raw input, so a non-ASCII look-alike can never fold into a valid letter.
  const sepRaw = raw.lastIndexOf("1");
  for (let i = sepRaw + 1; i < raw.length; i++) {
    const c = raw[i]!;
    if (BECH32_CHARSET.indexOf(c) < 0 && BECH32_CHARSET.toUpperCase().indexOf(c) < 0) {
      return {
        ok: false,
        reason: `The address contains a character that is not valid in a bech32 address: '${c}'. Bech32 never uses 1, b, i or o after the separator.`,
      };
    }
  }
  let hasLower = false;
  let hasUpper = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) hasLower = true;
    else if (c >= 0x41 && c <= 0x5a) hasUpper = true;
  }
  if (hasLower && hasUpper) {
    return {
      ok: false,
      reason: "The address mixes upper and lower case letters. A bech32 address must be all lower case or all upper case.",
    };
  }
  const addr = asciiLower(raw);
  if (addr.length > 90) {
    return { ok: false, reason: `The address is too long (${addr.length} characters, maximum 90).` };
  }
  const sep = addr.lastIndexOf("1");
  const dataPart = addr.slice(sep + 1);
  if (dataPart.length < 6) {
    return { ok: false, reason: "The address is too short to contain a checksum." };
  }
  const words: number[] = [];
  for (const ch of dataPart) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) {
      return {
        ok: false,
        reason: `The address contains a character that is not valid in a bech32 address: '${ch}'. Bech32 never uses 1, b, i or o after the separator.`,
      };
    }
    words.push(v);
  }
  const poly = bech32Polymod([...hrpExpand(hrpLower), ...words]);
  let encoding: "bech32" | "bech32m";
  if (poly === BECH32_CONST) encoding = "bech32";
  else if (poly === BECH32M_CONST) encoding = "bech32m";
  else return { ok: false, reason: "The address checksum does not match. Check every character; one is wrong or missing." };

  const version = words[0]!;
  const program = fromWords(words.slice(1, -6));
  if (program === null) {
    return { ok: false, reason: "The address data is not correctly padded, so it is not a valid bech32 address." };
  }
  if (version > 16) {
    return { ok: false, reason: `Unknown witness version ${version}. Witness versions run from 0 to 16.` };
  }
  const notInUse = (what: string) =>
    `${what} is not yet in use on Bitcoin. Nothing defines how coins sent there could be spent, so sending to this address could lose the funds. This tool only sends to witness version 0 and 1 (Taproot) addresses.`;
  if (program.length < 2 || program.length > 40) {
    return {
      ok: false,
      reason: `Invalid witness program length (${program.length} bytes; must be between 2 and 40).`,
    };
  }
  if (version === 0 && encoding !== "bech32") {
    return {
      ok: false,
      reason: "Witness version 0 addresses must use bech32 encoding, but this one uses bech32m.",
    };
  }
  if (version !== 0 && encoding !== "bech32m") {
    return {
      ok: false,
      reason: `Witness version ${version} addresses must use bech32m encoding, but this one uses bech32.`,
    };
  }

  // Encoding is sound. Now the network.
  const belongsTo = BECH32_HRP[hrpLower]!;
  if (!belongsTo.includes(network)) return wrongNetwork(belongsTo, network);

  if (version === 0) {
    if (program.length === 20) return { ok: true, kind: "p2wpkh", scriptPubKey: witnessScript(0, program) };
    if (program.length === 32) return { ok: true, kind: "p2wsh", scriptPubKey: witnessScript(0, program) };
    return {
      ok: false,
      reason: `Invalid length for a witness version 0 program (${program.length} bytes; must be 20 or 32).`,
    };
  }
  if (version === 1) {
    if (program.length === 32) return { ok: true, kind: "p2tr", scriptPubKey: witnessScript(1, program) };
    if (program.length === 2 && program[0] === 0x4e && program[1] === 0x73) {
      return {
        ok: false,
        reason: "This is a pay-to-anchor address (BIP433). Anyone can spend coins sent to it, so you would lose the funds. It is not a wallet address.",
      };
    }
    return {
      ok: false,
      reason: notInUse(`A witness version 1 address with a ${program.length}-byte program is not a Taproot address (which has 32 bytes) and`),
    };
  }
  // Versions 2 to 16: valid to Bitcoin Core, refused here. See the note at the top of this file.
  return { ok: false, reason: notInUse(`This address uses witness version ${version}, which`) };
}

function witnessScript(version: number, program: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + program.length);
  out[0] = version === 0 ? 0x00 : 0x50 + version;
  out[1] = program.length;
  out.set(program, 2);
  return out;
}

// ---------------------------------------------------------------- base58check

const BASE58_CHARSET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array | { badChar: string } {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = BASE58_CHARSET.indexOf(ch);
    if (carry < 0) return { badChar: ch };
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    leading++;
  }
  const out = new Uint8Array(leading + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[leading + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

function validateBase58(addr: string, network: Network, decoded: Uint8Array): DestinationValidation {
  if (decoded.length !== 25) {
    return {
      ok: false,
      reason: `Invalid address length (${addr.length} characters decode to ${decoded.length} bytes; a legacy address decodes to 25).`,
    };
  }
  const payload = decoded.subarray(0, 21);
  const check = sha256(sha256(payload)).subarray(0, 4);
  const given = decoded.subarray(21);
  if (check[0] !== given[0] || check[1] !== given[1] || check[2] !== given[2] || check[3] !== given[3]) {
    return { ok: false, reason: "The address checksum does not match. Check every character; one is wrong or missing." };
  }
  const version = decoded[0]!;
  const info = LEGACY_VERSION[version];
  if (!info) {
    return {
      ok: false,
      reason: `Legacy address version ${version} is not a supported Bitcoin address type (only P2PKH and P2SH are).`,
    };
  }
  if (!info.networks.includes(network)) return wrongNetwork(info.networks, network);
  const hash = decoded.slice(1, 21);
  if (info.kind === "p2pkh") {
    const script = new Uint8Array(25);
    script.set([0x76, 0xa9, 0x14], 0); // OP_DUP OP_HASH160 PUSH20
    script.set(hash, 3);
    script.set([0x88, 0xac], 23); // OP_EQUALVERIFY OP_CHECKSIG
    return { ok: true, kind: "p2pkh", scriptPubKey: script };
  }
  const script = new Uint8Array(23);
  script.set([0xa9, 0x14], 0); // OP_HASH160 PUSH20
  script.set(hash, 2);
  script[22] = 0x87; // OP_EQUAL
  return { ok: true, kind: "p2sh", scriptPubKey: script };
}

// ---------------------------------------------------------------- entry point

/**
 * Validate a destination address for the given network and return its output script.
 * Never returns ok for an address with a failing checksum.
 */
export function validateDestination(address: string, network: Network): DestinationValidation {
  if (typeof address !== "string" || address.length === 0) return { ok: false, reason: "No address given." };
  const addr = address;
  // Exact input only. The UI trims before calling; here any whitespace is an error.
  for (let i = 0; i < addr.length; i++) {
    const c = addr.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xa0 || c === 0x200b || c === 0xfeff) {
      return { ok: false, reason: "The address contains a space, tab or line break. Remove it and try again." };
    }
    if (c < 0x21 || c > 0x7e) {
      return {
        ok: false,
        reason: `The address contains a character that is not valid in a Bitcoin address: '${addr[i]}' (U+${c.toString(16).toUpperCase().padStart(4, "0")}). Only plain ASCII letters and digits are allowed.`,
      };
    }
  }
  const sep = addr.lastIndexOf("1");
  if (sep > 0) {
    const hrp = asciiLower(addr.slice(0, sep));
    if (BECH32_HRP[hrp]) return validateBech32(addr, hrp, network);
  }
  const decoded = base58Decode(addr);
  if (decoded instanceof Uint8Array) return validateBase58(addr, network, decoded);
  if (/^[a-z]+1[a-z0-9]+$/i.test(addr)) {
    return {
      ok: false,
      reason: `Unrecognised address prefix '${addr.slice(0, sep)}'. Bitcoin bech32 addresses start with bc1, tb1 or bcrt1.`,
    };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]/.test(addr)) {
    return {
      ok: false,
      reason: `The address contains a character that is not valid in a Bitcoin address: '${decoded.badChar}'. Base58 never uses 0, O, I or l.`,
    };
  }
  return { ok: false, reason: "This is not a recognised Bitcoin address format." };
}
