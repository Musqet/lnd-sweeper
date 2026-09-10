/**
 * aezeed cipher seed, version 0. A faithful port of the decode (and encode)
 * side of lnd/aezeed/cipherseed.go.
 *
 * Layout of the 33 enciphered bytes that the 24 words encode (11 bits each):
 *
 *   [0]      external version (0)
 *   [1..24)  aez ciphertext: 19-byte plaintext + 4 bytes expansion (tau = 4)
 *   [24..29) scrypt salt (5 bytes, public)
 *   [29..33) CRC-32C over bytes [0..29), big-endian
 *
 * Plaintext: internal version (1) || birthday days since genesis (u16 BE) || entropy (16).
 * Key: scrypt(passphrase or "aezeed", salt, N=32768, r=8, p=1, 32 bytes).
 * AD:  version byte || salt. Nonce: empty.
 */

import { scrypt, scryptAsync } from "@noble/hashes/scrypt.js";
import type { CipherSeed } from "../types";
import { aezDecrypt, aezEncrypt } from "./aez";
import { WORDLIST, WORD_INDEX } from "./wordlist";

// ---------------------------------------------------------------------------
// Constants (names follow lnd)
// ---------------------------------------------------------------------------

export const CIPHER_SEED_VERSION = 0;
export const DECIPHERED_CIPHER_SEED_SIZE = 19;
export const ENCIPHERED_CIPHER_SEED_SIZE = 33;
export const CIPHER_TEXT_EXPANSION = 4;
export const ENTROPY_SIZE = 16;
export const NUM_MNEMONIC_WORDS = 24;
export const SALT_SIZE = 5;
export const BITS_PER_WORD = 11;
const CHECKSUM_SIZE = 4;
const KEY_LEN = 32;
const SALT_OFFSET = ENCIPHERED_CIPHER_SEED_SIZE - CHECKSUM_SIZE - SALT_SIZE; // 24
const CHECKSUM_OFFSET = ENCIPHERED_CIPHER_SEED_SIZE - CHECKSUM_SIZE; // 29
const DEFAULT_PASSPHRASE = "aezeed";

/** Unix seconds of the Bitcoin genesis block; birthdays count days from here. */
export const BITCOIN_GENESIS_UNIX_SECONDS = 1231006505;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** The parameters lnd ties to cipher seed version 0. Deciphering a real seed needs these. */
export const PRODUCTION_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ N: 32768, r: 8, p: 1 });

/**
 * A passphrase is either a JS string (UTF-8 encoded, as lnd does with a Go
 * string) or raw bytes passed through untouched, matching lnd's []byte API.
 * Empty (zero length) means the default passphrase "aezeed".
 */
export type Passphrase = string | Uint8Array;

export interface DecipherOptions {
  /** Override scrypt parameters. Tests only; real seeds need PRODUCTION_SCRYPT_PARAMS. */
  scrypt?: ScryptParams;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AezeedError extends Error {
  override readonly name: string = "AezeedError";
}

/** The mnemonic did not contain exactly 24 words. */
export class WordCountError extends AezeedError {
  override readonly name = "WordCountError";
  constructor(readonly count: number) {
    super(`expected ${NUM_MNEMONIC_WORDS} words, got ${count}`);
  }
}

/** A word is not in the aezeed word list. `index` is zero based. */
export class UnknownWordError extends AezeedError {
  override readonly name = "UnknownWordError";
  constructor(
    readonly word: string,
    readonly index: number,
    readonly suggestions: readonly string[],
  ) {
    super(`word ${JSON.stringify(word)} is not in the word list (index=${index})`);
  }
}

/** The CRC-32C over the decoded bytes does not match: one or more words are wrong. */
export class ChecksumError extends AezeedError {
  override readonly name = "ChecksumError";
  constructor() {
    super("mnemonic phrase checksum doesn't match");
  }
}

/**
 * The external version byte is not 0. lnd checks this before the checksum, so
 * a typo in the first word surfaces here rather than as a ChecksumError;
 * `checksumValid` tells the two cases apart.
 */
export class WrongVersionError extends AezeedError {
  override readonly name = "WrongVersionError";
  constructor(
    readonly version: number,
    readonly checksumValid: boolean,
  ) {
    super(`wrong seed version ${version}, expected ${CIPHER_SEED_VERSION}`);
  }
}

/** aez authentication failed: wrong passphrase (the words themselves passed the checksum). */
export class InvalidPassphraseError extends AezeedError {
  override readonly name = "InvalidPassphraseError";
  constructor() {
    super("invalid passphrase");
  }
}

// ---------------------------------------------------------------------------
// CRC-32C (Castagnoli), matching Go's hash/crc32 with crc32.Castagnoli
// ---------------------------------------------------------------------------

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32C_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Word handling
// ---------------------------------------------------------------------------

/**
 * Normalises user input into a word array. Does not validate the words.
 *
 * A string is split on any whitespace (spaces, newlines, tabs). An array is
 * normalised element by element and keeps its length, so an empty entry stays
 * an empty word and is later reported as UnknownWordError at that index, which
 * is what the UI needs to highlight the right box.
 *
 * Deliberately more lenient than lnd, which rejects "Abandon" and "inflict "
 * as unknown words: we trim, lowercase and NFKD-normalise each word, as
 * chantools does. This never changes which seed a valid mnemonic maps to, it
 * only accepts input lnd would bounce.
 */
export function normaliseMnemonic(input: string | readonly string[]): string[] {
  const clean = (w: string): string => w.normalize("NFKD").toLowerCase().trim();
  if (Array.isArray(input)) return (input as readonly string[]).map(clean);
  return (input as string)
    .split(/\s+/u)
    .map(clean)
    .filter((w) => w.length > 0);
}

export interface WordValidation {
  word: string;
  valid: boolean;
  /** Closest list words for an invalid entry: exact-prefix matches first, then edit distance 1. */
  suggestions: string[];
}

function levenshteinAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return true;
  }
  // One insertion/deletion: walk both, allow a single skip in the longer one.
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j++;
    }
  }
  return true;
}

/** Suggestions for a word not in the list. Prefix matches first, then edit distance 1. Capped at `max`. */
export function suggestWords(word: string, max = 5): string[] {
  const w = word.toLowerCase();
  if (w.length === 0) return [];
  if (WORD_INDEX.has(w)) return [w];
  const prefix: string[] = [];
  const near: string[] = [];
  for (const candidate of WORDLIST) {
    if (w.length >= 2 && candidate.startsWith(w)) prefix.push(candidate);
    else if (levenshteinAtMost1(w, candidate)) near.push(candidate);
  }
  return [...prefix, ...near].slice(0, max);
}

/** Per-word validity plus suggestions for anything not in the list. Does not check the count. */
export function validateWords(words: readonly string[]): WordValidation[] {
  return words.map((raw) => {
    const word = raw.trim().toLowerCase();
    const valid = WORD_INDEX.has(word);
    return { word, valid, suggestions: valid ? [] : suggestWords(word) };
  });
}

/** Checks count and membership; returns the normalised words. Throws WordCountError or UnknownWordError. */
export function checkMnemonicWords(input: string | readonly string[]): string[] {
  const words = normaliseMnemonic(input);
  if (words.length !== NUM_MNEMONIC_WORDS) throw new WordCountError(words.length);
  for (const [i, w] of words.entries()) {
    if (!WORD_INDEX.has(w)) throw new UnknownWordError(w, i, suggestWords(w));
  }
  return words;
}

// ---------------------------------------------------------------------------
// Bit packing: 24 words x 11 bits <-> 33 bytes, MSB first
// ---------------------------------------------------------------------------

/** Maps 24 list words to the 33 enciphered bytes. Words must already be validated. */
export function mnemonicToBytes(words: readonly string[]): Uint8Array {
  if (words.length !== NUM_MNEMONIC_WORDS) throw new WordCountError(words.length);
  const out = new Uint8Array(ENCIPHERED_CIPHER_SEED_SIZE);
  let bitPos = 0;
  for (const [i, w] of words.entries()) {
    const index = WORD_INDEX.get(w);
    if (index === undefined) throw new UnknownWordError(w, i, suggestWords(w));
    for (let b = BITS_PER_WORD - 1; b >= 0; b--, bitPos++) {
      if ((index >>> b) & 1) out[bitPos >>> 3] = out[bitPos >>> 3]! | (0x80 >>> (bitPos & 7));
    }
  }
  return out;
}

/** Maps the 33 enciphered bytes to 24 list words. */
export function bytesToMnemonic(bytes: Uint8Array): string[] {
  if (bytes.length !== ENCIPHERED_CIPHER_SEED_SIZE) {
    throw new RangeError(`enciphered seed must be ${ENCIPHERED_CIPHER_SEED_SIZE} bytes`);
  }
  const words: string[] = [];
  let bitPos = 0;
  for (let i = 0; i < NUM_MNEMONIC_WORDS; i++) {
    let index = 0;
    for (let b = 0; b < BITS_PER_WORD; b++, bitPos++) {
      index = (index << 1) | ((bytes[bitPos >>> 3]! >>> (7 - (bitPos & 7))) & 1);
    }
    words.push(WORDLIST[index]!);
  }
  return words;
}

// ---------------------------------------------------------------------------
// Decipher
// ---------------------------------------------------------------------------

function encodeAD(version: number, salt: Uint8Array): Uint8Array {
  const ad = new Uint8Array(1 + SALT_SIZE);
  ad[0] = version;
  ad.set(salt, 1);
  return ad;
}

function passphraseBytes(passphrase: Passphrase): Uint8Array {
  if (passphrase.length === 0) return new TextEncoder().encode(DEFAULT_PASSPHRASE);
  return typeof passphrase === "string" ? new TextEncoder().encode(passphrase) : passphrase;
}

interface PreparedDecipher {
  ciphertext: Uint8Array;
  salt: Uint8Array;
  ad: Uint8Array;
}

/** Everything before the KDF: version check, checksum check, salt and AD extraction. */
function prepareDecipher(enciphered: Uint8Array): PreparedDecipher {
  if (enciphered.length !== ENCIPHERED_CIPHER_SEED_SIZE) {
    throw new RangeError(`enciphered seed must be ${ENCIPHERED_CIPHER_SEED_SIZE} bytes`);
  }
  const expected = crc32c(enciphered.subarray(0, CHECKSUM_OFFSET));
  const actual = readU32BE(enciphered, CHECKSUM_OFFSET);
  const checksumValid = expected === actual;

  // lnd checks the version before the checksum. Same order here.
  if (enciphered[0] !== CIPHER_SEED_VERSION) throw new WrongVersionError(enciphered[0]!, checksumValid);
  if (!checksumValid) throw new ChecksumError();

  const salt = enciphered.slice(SALT_OFFSET, SALT_OFFSET + SALT_SIZE);
  return {
    ciphertext: enciphered.slice(1, SALT_OFFSET),
    salt,
    ad: encodeAD(CIPHER_SEED_VERSION, salt),
  };
}

/** Everything after the KDF: aez decrypt and plaintext decode. */
function finishDecipher(prep: PreparedDecipher, key: Uint8Array): CipherSeed {
  const plain = aezDecrypt(key, new Uint8Array(0), [prep.ad], CIPHER_TEXT_EXPANSION, prep.ciphertext);
  key.fill(0);
  if (plain === null) throw new InvalidPassphraseError();
  if (plain.length !== DECIPHERED_CIPHER_SEED_SIZE) throw new AezeedError("unexpected plaintext length");
  const seed: CipherSeed = {
    internalVersion: plain[0]!,
    birthdayDays: (plain[1]! << 8) | plain[2]!,
    entropy: plain.slice(3, 3 + ENTROPY_SIZE),
    salt: prep.salt,
  };
  plain.fill(0);
  return seed;
}

function readU32BE(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

function writeU32BE(b: Uint8Array, off: number, v: number): void {
  b[off] = v >>> 24;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

function scryptOpts(params: ScryptParams) {
  return { N: params.N, r: params.r, p: params.p, dkLen: KEY_LEN };
}

/**
 * Deciphers 33 enciphered bytes with the passphrase. Async: scrypt yields to
 * the event loop so the UI stays responsive. Throws WrongVersionError,
 * ChecksumError or InvalidPassphraseError.
 */
export async function decipherBytes(
  enciphered: Uint8Array,
  passphrase: Passphrase = "",
  opts: DecipherOptions = {},
): Promise<CipherSeed> {
  const prep = prepareDecipher(enciphered);
  const key = await scryptAsync(passphraseBytes(passphrase), prep.salt, scryptOpts(opts.scrypt ?? PRODUCTION_SCRYPT_PARAMS));
  return finishDecipher(prep, key);
}

/** Synchronous decipherBytes. Blocks for the whole scrypt; tests and non-UI use only. */
export function decipherBytesSync(enciphered: Uint8Array, passphrase: Passphrase = "", opts: DecipherOptions = {}): CipherSeed {
  const prep = prepareDecipher(enciphered);
  const key = scrypt(passphraseBytes(passphrase), prep.salt, scryptOpts(opts.scrypt ?? PRODUCTION_SCRYPT_PARAMS));
  return finishDecipher(prep, key);
}

/**
 * Deciphers a 24-word aezeed mnemonic. Accepts a string or word array;
 * whitespace and case are normalised. Throws WordCountError,
 * UnknownWordError, WrongVersionError, ChecksumError or InvalidPassphraseError.
 */
export async function decipherMnemonic(
  mnemonic: string | readonly string[],
  passphrase: Passphrase = "",
  opts: DecipherOptions = {},
): Promise<CipherSeed> {
  return decipherBytes(mnemonicToBytes(checkMnemonicWords(mnemonic)), passphrase, opts);
}

/** Synchronous decipherMnemonic. Blocks for the whole scrypt; tests and non-UI use only. */
export function decipherMnemonicSync(
  mnemonic: string | readonly string[],
  passphrase: Passphrase = "",
  opts: DecipherOptions = {},
): CipherSeed {
  return decipherBytesSync(mnemonicToBytes(checkMnemonicWords(mnemonic)), passphrase, opts);
}

// ---------------------------------------------------------------------------
// Encipher (for round-trip tests and seed generation)
// ---------------------------------------------------------------------------

function encodePlaintext(seed: CipherSeed): Uint8Array {
  if (seed.entropy.length !== ENTROPY_SIZE) throw new RangeError(`entropy must be ${ENTROPY_SIZE} bytes`);
  if (seed.salt.length !== SALT_SIZE) throw new RangeError(`salt must be ${SALT_SIZE} bytes`);
  if (!Number.isInteger(seed.internalVersion) || seed.internalVersion < 0 || seed.internalVersion > 0xff) {
    throw new RangeError("internalVersion must fit one byte");
  }
  if (!Number.isInteger(seed.birthdayDays) || seed.birthdayDays < 0 || seed.birthdayDays > 0xffff) {
    throw new RangeError("birthdayDays must fit two bytes");
  }
  const plain = new Uint8Array(DECIPHERED_CIPHER_SEED_SIZE);
  plain[0] = seed.internalVersion;
  plain[1] = seed.birthdayDays >>> 8;
  plain[2] = seed.birthdayDays & 0xff;
  plain.set(seed.entropy, 3);
  return plain;
}

function finishEncipher(seed: CipherSeed, plain: Uint8Array, key: Uint8Array): Uint8Array {
  const ad = encodeAD(CIPHER_SEED_VERSION, seed.salt);
  const ct = aezEncrypt(key, new Uint8Array(0), [ad], CIPHER_TEXT_EXPANSION, plain);
  key.fill(0);
  plain.fill(0);

  const out = new Uint8Array(ENCIPHERED_CIPHER_SEED_SIZE);
  out[0] = CIPHER_SEED_VERSION;
  out.set(ct, 1);
  out.set(seed.salt, SALT_OFFSET);
  writeU32BE(out, CHECKSUM_OFFSET, crc32c(out.subarray(0, CHECKSUM_OFFSET)));
  return out;
}

/** Enciphers a seed to the 33-byte form: version || ciphertext || salt || checksum. */
export async function encipherBytes(seed: CipherSeed, passphrase: Passphrase = "", opts: DecipherOptions = {}): Promise<Uint8Array> {
  const plain = encodePlaintext(seed);
  const key = await scryptAsync(passphraseBytes(passphrase), seed.salt, scryptOpts(opts.scrypt ?? PRODUCTION_SCRYPT_PARAMS));
  return finishEncipher(seed, plain, key);
}

/** Synchronous encipherBytes. */
export function encipherBytesSync(seed: CipherSeed, passphrase: Passphrase = "", opts: DecipherOptions = {}): Uint8Array {
  const plain = encodePlaintext(seed);
  const key = scrypt(passphraseBytes(passphrase), seed.salt, scryptOpts(opts.scrypt ?? PRODUCTION_SCRYPT_PARAMS));
  return finishEncipher(seed, plain, key);
}

/** Enciphers a seed to its 24-word mnemonic. */
export async function mnemonicFromCipherSeed(seed: CipherSeed, passphrase: Passphrase = "", opts: DecipherOptions = {}): Promise<string[]> {
  return bytesToMnemonic(await encipherBytes(seed, passphrase, opts));
}

/** Synchronous mnemonicFromCipherSeed. */
export function mnemonicFromCipherSeedSync(seed: CipherSeed, passphrase: Passphrase = "", opts: DecipherOptions = {}): string[] {
  return bytesToMnemonic(encipherBytesSync(seed, passphrase, opts));
}

// ---------------------------------------------------------------------------
// Birthday helpers
// ---------------------------------------------------------------------------

/** Converts a birthday (days since genesis) to a Date, as lnd's BirthdayTime does. */
export function birthdayToDate(birthdayDays: number): Date {
  return new Date((BITCOIN_GENESIS_UNIX_SECONDS + birthdayDays * 86400) * 1000);
}

/** Converts a Date to a birthday in days since genesis, truncating, as lnd's New does. */
export function dateToBirthday(date: Date): number {
  const days = Math.floor((date.getTime() / 1000 - BITCOIN_GENESIS_UNIX_SECONDS) / 86400);
  if (days < 0 || days > 0xffff) throw new RangeError("date outside the aezeed birthday range");
  return days;
}
