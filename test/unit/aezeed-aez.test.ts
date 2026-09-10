/**
 * AEZ v5 test vectors from github.com/Yawning/aez testdata (copied into
 * test/fixtures/aez). Vector shapes follow aez_test.go:
 *   extract: {a, b}                    Extract(a) = b
 *   hash:    {k, tau, data[], v}       AEZ-hash(k, tau bits, data[0]=nonce, data[1..]=ad) = v
 *   prf:     {k, delta, tau, r}        AEZ-prf(k, delta, tau bytes) = r
 *   encrypt: {k, nonce, data[], tau, m, c}  Encrypt(k, nonce, data, tau bytes, m) = c
 */
import { describe, expect, it } from "vitest";
import { aezDecrypt, aezEncrypt, aezInternals } from "../../src/aezeed/aez";

// Loaded as raw text via vite so the test needs no node type definitions.
const fixtureText = import.meta.glob<string>("../fixtures/aez/*.json", { query: "?raw", import: "default", eager: true });

function fixture<T>(name: string): T {
  const text = fixtureText[`../fixtures/aez/${name}.json`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return JSON.parse(text) as T;
}

function hex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

interface ExtractVector {
  a: string;
  b: string;
}
interface HashVector {
  k: string;
  tau: number;
  data: string[];
  v: string;
}
interface PrfVector {
  k: string;
  delta: string;
  tau: number;
  r: string;
}
interface EncryptVector {
  k: string;
  nonce: string;
  data: string[];
  tau: number;
  m: string;
  c: string;
}

describe("aez extract", () => {
  const vectors = fixture<ExtractVector[]>("extract");
  it(`passes all ${vectors.length} vectors`, () => {
    for (const [i, v] of vectors.entries()) {
      expect(toHex(aezInternals.extract(hex(v.a))), `vector ${i}`).toBe(v.b);
    }
  });
});

describe("aez hash", () => {
  const vectors = fixture<HashVector[]>("hash");
  it(`passes all ${vectors.length} vectors`, () => {
    for (const [i, v] of vectors.entries()) {
      const data = v.data.map(hex);
      const nonce = data[0] ?? new Uint8Array(0);
      const ad = data.slice(1);
      expect(toHex(aezInternals.hash(hex(v.k), nonce, ad, v.tau)), `vector ${i}`).toBe(v.v);
    }
  });
});

describe("aez prf", () => {
  const vectors = fixture<PrfVector[]>("prf");
  it(`passes all ${vectors.length} vectors`, () => {
    for (const [i, v] of vectors.entries()) {
      expect(toHex(aezInternals.prf(hex(v.k), hex(v.delta), v.tau)), `vector ${i}`).toBe(v.r);
    }
  });
});

function assertEncrypt(vectors: EncryptVector[]): void {
  for (const [i, v] of vectors.entries()) {
    const k = hex(v.k);
    const nonce = hex(v.nonce);
    const ad = v.data.map(hex);
    const m = hex(v.m);
    const c = aezEncrypt(k, nonce, ad, v.tau, m);
    expect(toHex(c), `encrypt vector ${i} (len ${m.length}, tau ${v.tau})`).toBe(v.c);

    const back = aezDecrypt(k, nonce, ad, v.tau, hex(v.c));
    expect(back, `decrypt vector ${i} authenticates`).not.toBeNull();
    expect(toHex(back!), `decrypt vector ${i}`).toBe(v.m);
  }
}

describe("aez encrypt/decrypt", () => {
  const main = fixture<EncryptVector[]>("encrypt");
  it(`passes all ${main.length} encrypt.json vectors (lengths 0..511)`, () => {
    assertEncrypt(main);
  });
  it("covers both the tiny (<32) and core (>=32) paths", () => {
    const lens = new Set(main.map((v) => v.m.length / 2));
    for (let n = 0; n < 64; n++) expect(lens.has(n), `length ${n}`).toBe(true);
  });
  for (const name of ["encrypt_no_ad", "encrypt_33_byte_ad", "encrypt_16_byte_key"] as const) {
    const vs = fixture<EncryptVector[]>(name);
    it(`passes all ${vs.length} ${name}.json vectors`, () => {
      assertEncrypt(vs);
    });
  }
});

describe("aez authentication", () => {
  const key = new Uint8Array(32).fill(7);
  const ad = [new Uint8Array([0, 1, 2, 3, 4, 5])];
  const pt = new Uint8Array(19).map((_, i) => i * 13);

  it("rejects a flipped ciphertext bit at every position (aezeed sizes: 19 byte pt, tau 4)", () => {
    const ct = aezEncrypt(key, new Uint8Array(0), ad, 4, pt);
    expect(ct.length).toBe(23);
    for (let i = 0; i < ct.length; i++) {
      const bad = new Uint8Array(ct);
      bad[i] = bad[i]! ^ 0x01;
      expect(aezDecrypt(key, new Uint8Array(0), ad, 4, bad), `byte ${i}`).toBeNull();
    }
    expect(aezDecrypt(key, new Uint8Array(0), ad, 4, ct)).toEqual(pt);
  });

  it("rejects a changed key or AD", () => {
    const ct = aezEncrypt(key, new Uint8Array(0), ad, 4, pt);
    const otherKey = new Uint8Array(32).fill(8);
    expect(aezDecrypt(otherKey, new Uint8Array(0), ad, 4, ct)).toBeNull();
    expect(aezDecrypt(key, new Uint8Array(0), [new Uint8Array([9, 1, 2, 3, 4, 5])], 4, ct)).toBeNull();
    expect(aezDecrypt(key, new Uint8Array(0), [], 4, ct)).toBeNull();
  });

  it("returns null when the ciphertext is shorter than tau", () => {
    expect(aezDecrypt(key, new Uint8Array(0), ad, 4, new Uint8Array(3))).toBeNull();
  });
});
