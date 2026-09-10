/**
 * AEZ v5 (Hoang, Krovetz, Rogaway), ported from Yawning Angel's Go
 * implementation (github.com/Yawning/aez, CC0), which is itself derived from
 * the AEZ v5 reference code. Only what aezeed needs is here: Encrypt and
 * Decrypt with arbitrary nonce, a vector of associated data, and tau bytes of
 * ciphertext expansion.
 *
 * The AES round function is table driven (T-tables computed from the S-box at
 * load time) and is not constant time. That is acceptable here: the key is a
 * scrypt output that only ever encrypts one 19-byte message, in a browser,
 * with no attacker able to time it.
 *
 * Byte handling mirrors the Go code closely so it can be checked against it
 * line by line. Speed is irrelevant for our message sizes.
 */

import { blake2b } from "@noble/hashes/blake2.js";

const BLOCK = 16;
const EXTRACTED_KEY_SIZE = 3 * BLOCK;

// ---------------------------------------------------------------------------
// AES round function
// ---------------------------------------------------------------------------

// prettier-ignore
const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

// T-tables: TE0[x] = (2s, s, s, 3s) with s = SBOX[x], big-endian; TE1..TE3 are
// byte rotations of TE0. One lookup per state byte does SubBytes + MixColumns
// for one column contribution; ShiftRows is folded into the byte selection.
const TE0 = new Uint32Array(256);
const TE1 = new Uint32Array(256);
const TE2 = new Uint32Array(256);
const TE3 = new Uint32Array(256);
{
  const rotr = (v: number, n: number): number => ((v >>> n) | (v << (32 - n))) >>> 0;
  for (let x = 0; x < 256; x++) {
    const s = SBOX[x]!;
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff;
    const s3 = s2 ^ s;
    const t0 = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    TE0[x] = t0;
    TE1[x] = rotr(t0, 8);
    TE2[x] = rotr(t0, 16);
    TE3[x] = rotr(t0, 24);
  }
}

function be32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

function putBe32(b: Uint8Array, off: number, v: number): void {
  b[off] = v >>> 24;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

/**
 * Runs `n` AES rounds (SubBytes, ShiftRows, MixColumns, AddRoundKey) in place
 * on a 16-byte block. No initial key addition; callers xor in the whitening
 * themselves, exactly as the Go reference does.
 */
function aesRounds(block: Uint8Array, keys: Uint32Array, n: number): void {
  let s0 = be32(block, 0);
  let s1 = be32(block, 4);
  let s2 = be32(block, 8);
  let s3 = be32(block, 12);
  for (let r = 0; r < n; r++) {
    const k = r * 4;
    const t0 = TE0[s0 >>> 24]! ^ TE1[(s1 >>> 16) & 0xff]! ^ TE2[(s2 >>> 8) & 0xff]! ^ TE3[s3 & 0xff]! ^ keys[k]!;
    const t1 = TE0[s1 >>> 24]! ^ TE1[(s2 >>> 16) & 0xff]! ^ TE2[(s3 >>> 8) & 0xff]! ^ TE3[s0 & 0xff]! ^ keys[k + 1]!;
    const t2 = TE0[s2 >>> 24]! ^ TE1[(s3 >>> 16) & 0xff]! ^ TE2[(s0 >>> 8) & 0xff]! ^ TE3[s1 & 0xff]! ^ keys[k + 2]!;
    const t3 = TE0[s3 >>> 24]! ^ TE1[(s0 >>> 16) & 0xff]! ^ TE2[(s1 >>> 8) & 0xff]! ^ TE3[s2 & 0xff]! ^ keys[k + 3]!;
    s0 = t0 >>> 0;
    s1 = t1 >>> 0;
    s2 = t2 >>> 0;
    s3 = t3 >>> 0;
  }
  putBe32(block, 0, s0);
  putBe32(block, 4, s1);
  putBe32(block, 8, s2);
  putBe32(block, 12, s3);
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

function xor1x16(a: Uint8Array, b: Uint8Array, dst: Uint8Array): void {
  for (let i = 0; i < BLOCK; i++) dst[i] = a[i]! ^ b[i]!;
}

function xor4x16(a: Uint8Array, b: Uint8Array, c: Uint8Array, d: Uint8Array, dst: Uint8Array): void {
  for (let i = 0; i < BLOCK; i++) dst[i] = a[i]! ^ b[i]! ^ c[i]! ^ d[i]!;
}

/** dst[i] = a[i] ^ b[i] for i < dst.length. */
function xorBytes(a: Uint8Array, b: Uint8Array, dst: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = a[i]! ^ b[i]!;
}

/** Multiply by x in GF(2^128) with the AEZ polynomial (x^128 + x^7 + x^2 + x + 1). */
function doubleBlock(p: Uint8Array): void {
  const tmp = p[0]!;
  for (let i = 0; i < 15; i++) p[i] = ((p[i]! << 1) | (p[i + 1]! >>> 7)) & 0xff;
  p[15] = ((p[15]! << 1) ^ (tmp >>> 7 ? 135 : 0)) & 0xff;
}

/** dst = x * src in GF(2^128), x a small non-secret integer. */
function multBlock(x: number, src: Uint8Array, dst: Uint8Array): void {
  const t = new Uint8Array(src);
  const r = new Uint8Array(BLOCK);
  while (x !== 0) {
    if (x & 1) xor1x16(r, t, r);
    doubleBlock(t);
    x >>>= 1;
  }
  dst.set(r);
}

function oneZeroPad(src: Uint8Array, sz: number, dst: Uint8Array): void {
  dst.fill(0);
  dst.set(src.subarray(0, sz));
  dst[sz] = 0x80;
}

const ZERO = new Uint8Array(BLOCK);

/** Extract: 48-byte keys are used as-is; anything else goes through BLAKE2b-384. */
function extract(k: Uint8Array): Uint8Array {
  if (k.length === EXTRACTED_KEY_SIZE) return new Uint8Array(k);
  return blake2b(k, { dkLen: EXTRACTED_KEY_SIZE });
}

// ---------------------------------------------------------------------------
// AEZ state
// ---------------------------------------------------------------------------

class AezState {
  readonly I: Uint8Array[] = [new Uint8Array(BLOCK), new Uint8Array(BLOCK)]; // 1I, 2I
  readonly J: Uint8Array[] = [new Uint8Array(BLOCK), new Uint8Array(BLOCK), new Uint8Array(BLOCK)]; // 1J, 2J, 4J
  readonly L: Uint8Array[] = Array.from({ length: 8 }, () => new Uint8Array(BLOCK)); // 0L..7L
  private readonly aes10Key = new Uint32Array(4 * 10);
  private readonly aes4Key = new Uint32Array(4 * 4);

  constructor(key: Uint8Array) {
    const ek = extract(key);

    this.I[0]!.set(ek.subarray(0, 16));
    multBlock(2, this.I[0]!, this.I[1]!);

    this.J[0]!.set(ek.subarray(16, 32));
    multBlock(2, this.J[0]!, this.J[1]!);
    multBlock(2, this.J[1]!, this.J[2]!);

    // L0 stays all zero.
    this.L[1]!.set(ek.subarray(32, 48));
    multBlock(2, this.L[1]!, this.L[2]!); // L2 = 2*L1
    xor1x16(this.L[2]!, this.L[1]!, this.L[3]!); // L3 = L2 + L1
    multBlock(2, this.L[2]!, this.L[4]!); // L4 = 2*L2
    xor1x16(this.L[4]!, this.L[1]!, this.L[5]!); // L5 = L4 + L1
    multBlock(2, this.L[3]!, this.L[6]!); // L6 = 2*L3
    xor1x16(this.L[6]!, this.L[1]!, this.L[7]!); // L7 = L6 + L1

    // Round keys, as big-endian words: I J L (12 words).
    const keys = new Uint32Array(12);
    for (let i = 0; i < 12; i++) keys[i] = be32(ek, 4 * i);
    const iK = keys.subarray(0, 4);
    const jK = keys.subarray(4, 8);
    const lK = keys.subarray(8, 12);

    // AES10: I J L I J L I J L I
    this.aes10Key.set(keys, 0);
    this.aes10Key.set(keys, 12);
    this.aes10Key.set(keys, 24);
    this.aes10Key.set(iK, 36);

    // AES4: J I L 0
    this.aes4Key.set(jK, 0);
    this.aes4Key.set(iK, 4);
    this.aes4Key.set(lK, 8);

    ek.fill(0);
    keys.fill(0);
  }

  /** dst = AES4(j ^ i ^ l ^ src). src may alias dst. */
  aes4(j: Uint8Array, i: Uint8Array, l: Uint8Array, src: Uint8Array, dst: Uint8Array): void {
    xor4x16(j, i, l, src, dst);
    aesRounds(dst, this.aes4Key, 4);
  }

  /** dst = AES10(l ^ src). src may alias dst. */
  aes10(l: Uint8Array, src: Uint8Array, dst: Uint8Array): void {
    xor1x16(src, l, dst);
    aesRounds(dst, this.aes10Key, 10);
  }

  /** Wipes key material. The state must not be used afterwards. */
  reset(): void {
    for (const b of this.I) b.fill(0);
    for (const b of this.J) b.fill(0);
    for (const b of this.L) b.fill(0);
    this.aes10Key.fill(0);
    this.aes4Key.fill(0);
  }

  /** AEZ-hash over (tau, nonce, ad...). tau here is in bits. */
  hash(nonce: Uint8Array, ad: readonly Uint8Array[], tau: number, result: Uint8Array): void {
    const buf = new Uint8Array(BLOCK);
    const sum = new Uint8Array(BLOCK);
    const I = new Uint8Array(BLOCK);
    const J = new Uint8Array(BLOCK);

    // Initialise sum with hash of tau.
    putBe32(buf, 12, tau >>> 0);
    xor1x16(this.J[0]!, this.J[1]!, J); // J ^ 2J = 3J
    this.aes4(J, this.I[1]!, this.L[1]!, buf, sum); // E(3,1)

    // Hash nonce, accumulate into sum.
    let empty = nonce.length === 0;
    let n = nonce;
    let nBytes = nonce.length;
    I.set(this.I[1]!);
    for (let i = 1; nBytes >= BLOCK; i++, nBytes -= BLOCK) {
      this.aes4(this.J[2]!, I, this.L[i % 8]!, n.subarray(0, BLOCK), buf); // E(4,i)
      xor1x16(sum, buf, sum);
      n = n.subarray(BLOCK);
      if (i % 8 === 0) doubleBlock(I);
    }
    if (nBytes > 0 || empty) {
      buf.fill(0);
      buf.set(n);
      buf[nBytes] = 0x80;
      this.aes4(this.J[2]!, this.I[0]!, this.L[0]!, buf, buf); // E(4,0)
      xor1x16(sum, buf, sum);
    }

    // Hash each vector element, accumulate into sum.
    for (let k = 0; k < ad.length; k++) {
      let p = ad[k]!;
      empty = p.length === 0;
      let bytes = p.length;
      I.set(this.I[1]!);
      multBlock(5 + k, this.J[0]!, J);
      for (let i = 1; bytes >= BLOCK; i++, bytes -= BLOCK) {
        this.aes4(J, I, this.L[i % 8]!, p.subarray(0, BLOCK), buf); // E(5+k,i)
        xor1x16(sum, buf, sum);
        p = p.subarray(BLOCK);
        if (i % 8 === 0) doubleBlock(I);
      }
      if (bytes > 0 || empty) {
        buf.fill(0);
        buf.set(p);
        buf[bytes] = 0x80;
        this.aes4(J, this.I[0]!, this.L[0]!, buf, buf); // E(5+k,0)
        xor1x16(sum, buf, sum);
      }
    }

    I.fill(0);
    J.fill(0);
    result.set(sum);
  }

  /** AEZ-prf: tau bytes of E(-1,3)(delta ^ ctr). */
  prf(delta: Uint8Array, tau: number, result: Uint8Array): void {
    const buf = new Uint8Array(BLOCK);
    const ctr = new Uint8Array(BLOCK);
    let off = 0;
    while (tau >= BLOCK) {
      xor1x16(delta, ctr, buf);
      this.aes10(this.L[3]!, buf, buf); // E(-1,3)
      result.set(buf, off);

      // ctr += 1 (big-endian)
      let i = 15;
      for (;;) {
        ctr[i] = (ctr[i]! + 1) & 0xff;
        i--;
        if (ctr[i + 1] !== 0) break;
      }

      tau -= BLOCK;
      off += BLOCK;
    }
    if (tau > 0) {
      xor1x16(delta, ctr, buf);
      this.aes10(this.L[3]!, buf, buf); // E(-1,3)
      result.set(buf.subarray(0, tau), off);
    }
    buf.fill(0);
  }

  private corePass1(inp: Uint8Array, out: Uint8Array, X: Uint8Array): void {
    const tmp = new Uint8Array(BLOCK);
    const I = new Uint8Array(this.I[1]!);
    let inBytes = inp.length;
    for (let i = 1; inBytes >= 64; i++, inBytes -= 32) {
      this.aes4(this.J[0]!, I, this.L[i % 8]!, inp.subarray(BLOCK, 2 * BLOCK), tmp); // E(1,i)
      xor1x16(inp, tmp, out.subarray(0, BLOCK));

      this.aes4(ZERO, this.I[0]!, this.L[0]!, out.subarray(0, BLOCK), tmp); // E(0,0)
      xor1x16(inp.subarray(BLOCK), tmp, out.subarray(BLOCK, 2 * BLOCK));
      xor1x16(out.subarray(BLOCK), X, X);

      inp = inp.subarray(32);
      out = out.subarray(32);
      if (i % 8 === 0) doubleBlock(I);
    }
    tmp.fill(0);
    I.fill(0);
  }

  private corePass2(inp: Uint8Array, out: Uint8Array, Y: Uint8Array, S: Uint8Array): void {
    const tmp = new Uint8Array(BLOCK);
    const I = new Uint8Array(this.I[1]!);
    let inBytes = inp.length;
    for (let i = 1; inBytes >= 64; i++, inBytes -= 32) {
      this.aes4(this.J[1]!, I, this.L[i % 8]!, S, tmp); // E(2,i)
      xor1x16(out, tmp, out.subarray(0, BLOCK));
      xor1x16(out.subarray(BLOCK), tmp, out.subarray(BLOCK, 2 * BLOCK));
      xor1x16(out, Y, Y);

      this.aes4(ZERO, this.I[0]!, this.L[0]!, out.subarray(BLOCK, 2 * BLOCK), tmp); // E(0,0)
      xor1x16(out, tmp, out.subarray(0, BLOCK));

      this.aes4(this.J[0]!, I, this.L[i % 8]!, out.subarray(0, BLOCK), tmp); // E(1,i)
      xor1x16(out.subarray(BLOCK), tmp, out.subarray(BLOCK, 2 * BLOCK));

      // swap blocks
      tmp.set(out.subarray(0, BLOCK));
      out.set(out.subarray(BLOCK, 2 * BLOCK), 0);
      out.set(tmp, BLOCK);

      inp = inp.subarray(32);
      out = out.subarray(32);
      if (i % 8 === 0) doubleBlock(I);
    }
    I.fill(0);
    tmp.fill(0);
  }

  /** AEZ-core: enciphering for messages of 32 bytes or more. d = 0 encipher, 1 decipher. */
  core(delta: Uint8Array, inOrig: Uint8Array, d: number, outOrig: Uint8Array): void {
    const tmp = new Uint8Array(BLOCK);
    const X = new Uint8Array(BLOCK);
    const Y = new Uint8Array(BLOCK);
    const S = new Uint8Array(BLOCK);
    const len = inOrig.length;

    let fragBytes = len % 32;
    const initialBytes = len - fragBytes - 32;

    // Pass 1 over in[0:-32], store intermediate values in out[0:-32].
    if (len >= 64) this.corePass1(inOrig, outOrig, X);

    // Finish X calculation.
    let inp = inOrig.subarray(initialBytes);
    if (fragBytes >= BLOCK) {
      this.aes4(ZERO, this.I[1]!, this.L[4]!, inp.subarray(0, BLOCK), tmp); // E(0,4)
      xor1x16(X, tmp, X);
      oneZeroPad(inp.subarray(BLOCK), fragBytes - BLOCK, tmp);
      this.aes4(ZERO, this.I[1]!, this.L[5]!, tmp, tmp); // E(0,5)
      xor1x16(X, tmp, X);
    } else if (fragBytes > 0) {
      oneZeroPad(inp, fragBytes, tmp);
      this.aes4(ZERO, this.I[1]!, this.L[4]!, tmp, tmp); // E(0,4)
      xor1x16(X, tmp, X);
    }

    // Calculate S.
    let out = outOrig.subarray(len - 32);
    inp = inOrig.subarray(len - 32);
    this.aes4(ZERO, this.I[1]!, this.L[(1 + d) % 8]!, inp.subarray(BLOCK, 2 * BLOCK), tmp); // E(0,1+d)
    xor4x16(X, inp, delta, tmp, out.subarray(0, BLOCK));
    this.aes10(this.L[(1 + d) % 8]!, out.subarray(0, BLOCK), tmp); // E(-1,1+d)
    xor1x16(inp.subarray(BLOCK), tmp, out.subarray(BLOCK, 2 * BLOCK));
    xor1x16(out, out.subarray(BLOCK), S);

    // Pass 2 over intermediate values in out[32..]. Final values written.
    if (len >= 64) this.corePass2(inOrig, outOrig, Y, S);

    // Finish Y calculation and finish encryption of fragment bytes.
    out = outOrig.subarray(initialBytes);
    inp = inOrig.subarray(initialBytes);
    if (fragBytes >= BLOCK) {
      this.aes10(this.L[4]!, S, tmp); // E(-1,4)
      xor1x16(inp, tmp, out.subarray(0, BLOCK));
      this.aes4(ZERO, this.I[1]!, this.L[4]!, out.subarray(0, BLOCK), tmp); // E(0,4)
      xor1x16(Y, tmp, Y);

      out = out.subarray(BLOCK);
      inp = inp.subarray(BLOCK);
      fragBytes -= BLOCK;

      this.aes10(this.L[5]!, S, tmp); // E(-1,5)
      xorBytes(inp, tmp, tmp.subarray(0, fragBytes));
      out.set(tmp.subarray(0, fragBytes));
      tmp.fill(0, fragBytes);
      tmp[fragBytes] = 0x80;
      this.aes4(ZERO, this.I[1]!, this.L[5]!, tmp, tmp); // E(0,5)
      xor1x16(Y, tmp, Y);
    } else if (fragBytes > 0) {
      this.aes10(this.L[4]!, S, tmp); // E(-1,4)
      xorBytes(inp, tmp, tmp.subarray(0, fragBytes));
      out.set(tmp.subarray(0, fragBytes));
      tmp.fill(0, fragBytes);
      tmp[fragBytes] = 0x80;
      this.aes4(ZERO, this.I[1]!, this.L[4]!, tmp, tmp); // E(0,4)
      xor1x16(Y, tmp, Y);
    }

    // Finish encryption of last two blocks.
    out = outOrig.subarray(len - 32);
    this.aes10(this.L[(2 - d) % 8]!, out.subarray(BLOCK), tmp); // E(-1,2-d)
    xor1x16(out, tmp, out.subarray(0, BLOCK));
    this.aes4(ZERO, this.I[1]!, this.L[(2 - d) % 8]!, out.subarray(0, BLOCK), tmp); // E(0,2-d)
    xor4x16(tmp, out.subarray(BLOCK), delta, Y, out.subarray(BLOCK, 2 * BLOCK));
    tmp.set(out.subarray(0, BLOCK));
    out.set(out.subarray(BLOCK, 2 * BLOCK), 0);
    out.set(tmp, BLOCK);

    X.fill(0);
    Y.fill(0);
    S.fill(0);
  }

  /** AEZ-tiny: Feistel-based enciphering for messages of 1 to 31 bytes. d = 0 encipher, 1 decipher. */
  tiny(delta: Uint8Array, inp: Uint8Array, d: number, out: Uint8Array): void {
    const buf = new Uint8Array(2 * BLOCK);
    const L = new Uint8Array(BLOCK);
    const R = new Uint8Array(BLOCK);
    const tmp = new Uint8Array(BLOCK);
    let mask = 0x00;
    let pad = 0x80;
    let rounds: number;
    let i = 7;
    let j = 0;
    let step: number;

    const inBytes = inp.length;
    if (inBytes === 1) rounds = 24;
    else if (inBytes === 2) rounds = 16;
    else if (inBytes < 16) rounds = 10;
    else {
      i = 6;
      rounds = 8;
    }

    const half = inBytes >>> 1; // inBytes/2
    const halfUp = (inBytes + 1) >>> 1; // (inBytes+1)/2

    // Split (inBytes*8)/2 bits into L and R. Beware: may end in a nibble.
    L.set(inp.subarray(0, halfUp));
    R.set(inp.subarray(half, half + halfUp));
    if (inBytes & 1) {
      // Shift R left by half a byte.
      for (let k = 0; k < half; k++) R[k] = ((R[k]! << 4) | (R[k + 1]! >>> 4)) & 0xff;
      R[half] = (R[half]! << 4) & 0xff;
      pad = 0x08;
      mask = 0xf0;
    }
    if (d !== 0) {
      if (inBytes < 16) {
        buf.fill(0, 0, BLOCK);
        buf.set(inp);
        buf[0] = buf[0]! | 0x80;
        xor1x16(delta, buf, buf.subarray(0, BLOCK));
        this.aes4(ZERO, this.I[1]!, this.L[3]!, buf.subarray(0, BLOCK), tmp); // E(0,3)
        L[0] = L[0]! ^ (tmp[0]! & 0x80);
      }
      j = rounds - 1;
      step = -1;
    } else {
      step = 1;
    }
    for (let k = 0; k < rounds / 2; k++, j += 2 * step) {
      buf.fill(0, 0, BLOCK);
      buf.set(R.subarray(0, halfUp));
      buf[half] = (buf[half]! & mask) | pad;
      xor1x16(buf, delta, buf.subarray(0, BLOCK));
      buf[15] = buf[15]! ^ (j & 0xff);
      this.aes4(ZERO, this.I[1]!, this.L[i]!, buf.subarray(0, BLOCK), tmp); // E(0,i)
      xor1x16(L, tmp, L);

      buf.fill(0, 0, BLOCK);
      buf.set(L.subarray(0, halfUp));
      buf[half] = (buf[half]! & mask) | pad;
      xor1x16(buf, delta, buf.subarray(0, BLOCK));
      buf[15] = buf[15]! ^ ((j + step) & 0xff);
      this.aes4(ZERO, this.I[1]!, this.L[i]!, buf.subarray(0, BLOCK), tmp); // E(0,i)
      xor1x16(R, tmp, R);
    }
    buf.set(R.subarray(0, half), 0);
    buf.set(L.subarray(0, halfUp), half);
    if (inBytes & 1) {
      for (let k = inBytes - 1; k > half; k--) buf[k] = ((buf[k]! >>> 4) | (buf[k - 1]! << 4)) & 0xff;
      buf[half] = (L[0]! >>> 4) | (R[half]! & 0xf0);
    }
    out.set(buf.subarray(0, inBytes));
    if (inBytes < 16 && d === 0) {
      buf.fill(0, inBytes, BLOCK);
      buf[0] = buf[0]! | 0x80;
      xor1x16(delta, buf, buf.subarray(0, BLOCK));
      this.aes4(ZERO, this.I[1]!, this.L[3]!, buf.subarray(0, BLOCK), tmp); // E(0,3)
      out[0] = out[0]! ^ (tmp[0]! & 0x80);
    }

    L.fill(0);
    R.fill(0);
    tmp.fill(0);
  }

  encipher(delta: Uint8Array, inp: Uint8Array, out: Uint8Array): void {
    if (inp.length === 0) return;
    if (inp.length < 32) this.tiny(delta, inp, 0, out);
    else this.core(delta, inp, 0, out);
  }

  decipher(delta: Uint8Array, inp: Uint8Array, out: Uint8Array): void {
    if (inp.length === 0) return;
    if (inp.length < 32) this.tiny(delta, inp, 1, out);
    else this.core(delta, inp, 1, out);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * AEZ Encrypt. Returns plaintext.length + tau bytes of ciphertext.
 * `tau` is the number of bytes of ciphertext expansion (authentication).
 */
export function aezEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  additionalData: readonly Uint8Array[],
  tau: number,
  plaintext: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(tau) || tau < 0) throw new RangeError("aez: tau must be a non-negative integer");
  const delta = new Uint8Array(BLOCK);
  const x = new Uint8Array(plaintext.length + tau);
  const e = new AezState(key);
  try {
    e.hash(nonce, additionalData, tau * 8, delta);
    if (plaintext.length === 0) {
      e.prf(delta, tau, x);
    } else {
      x.set(plaintext);
      e.encipher(delta, x, x);
    }
  } finally {
    e.reset();
    delta.fill(0);
  }
  return x;
}

/**
 * AEZ Decrypt. Returns the plaintext (ciphertext.length - tau bytes) or null
 * if authentication fails.
 */
export function aezDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  additionalData: readonly Uint8Array[],
  tau: number,
  ciphertext: Uint8Array,
): Uint8Array | null {
  if (!Number.isInteger(tau) || tau < 0) throw new RangeError("aez: tau must be a non-negative integer");
  if (ciphertext.length < tau) return null;

  const delta = new Uint8Array(BLOCK);
  const x = new Uint8Array(ciphertext.length);
  const e = new AezState(key);
  let sum = 0;
  try {
    e.hash(nonce, additionalData, tau * 8, delta);
    if (ciphertext.length === tau) {
      e.prf(delta, tau, x);
      for (let i = 0; i < tau; i++) sum |= x[i]! ^ ciphertext[i]!;
    } else {
      e.decipher(delta, ciphertext, x);
      for (let i = 0; i < tau; i++) sum |= x[ciphertext.length - tau + i]!;
    }
  } finally {
    e.reset();
    delta.fill(0);
  }
  if (sum !== 0) {
    x.fill(0);
    return null;
  }
  return x.slice(0, ciphertext.length - tau);
}

/** Test hooks for the AEZ internals, matched against the Go repo's testdata. Not for production use. */
export const aezInternals = {
  extract,
  hash(key: Uint8Array, nonce: Uint8Array, ad: readonly Uint8Array[], tauBits: number): Uint8Array {
    const e = new AezState(key);
    const out = new Uint8Array(BLOCK);
    e.hash(nonce, ad, tauBits, out);
    e.reset();
    return out;
  },
  prf(key: Uint8Array, delta: Uint8Array, tau: number): Uint8Array {
    const e = new AezState(key);
    const out = new Uint8Array(tau);
    e.prf(delta, tau, out);
    e.reset();
    return out;
  },
};
