import { describe, expect, it } from "vitest";
import {
  ChecksumError,
  InvalidPassphraseError,
  PRODUCTION_SCRYPT_PARAMS,
  UnknownWordError,
  WORDLIST,
  WORD_INDEX,
  WordCountError,
  WrongVersionError,
  birthdayToDate,
  bytesToMnemonic,
  crc32c,
  dateToBirthday,
  decipherMnemonic,
  decipherMnemonicSync,
  encipherBytesSync,
  mnemonicFromCipherSeed,
  mnemonicFromCipherSeedSync,
  mnemonicToBytes,
  normaliseMnemonic,
  suggestWords,
  validateWords,
  type CipherSeed,
} from "../../src/aezeed";

interface Vector {
  name: string;
  entropy_hex: string;
  salt_hex: string;
  passphrase: string;
  birthday_days: number;
  internal_version: number;
  enciphered_hex: string;
  mnemonic: string[];
}

import vectorsRaw from "../fixtures/aezeed-vectors.json?raw";

const vectors: Vector[] = JSON.parse(vectorsRaw) as Vector[];

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// lnd's cipherseed_test.go lowers scrypt to N=16 in init(); its two published
// mnemonics were produced with these parameters and do NOT decipher with the
// production N=32768. They are still useful as an independent check of the
// whole pipeline (bit packing, CRC, AD, aez) against lnd's own code.
const LND_TEST_SCRYPT = { N: 16, r: 8, p: 1 };
const lndTestEntropy = hex("81b637d86359e6960de795e41e0b4cfd");
const lndTestSalt = new TextEncoder().encode("salt1");
const lndTestVectors: { seed: CipherSeed; passphrase: string; mnemonic: string }[] = [
  {
    seed: { internalVersion: 0, birthdayDays: 0, entropy: lndTestEntropy, salt: lndTestSalt },
    passphrase: "",
    mnemonic:
      "ability liquid travel stem barely drastic pact cupboard apple thrive morning oak " +
      "feature tissue couch old math inform success suggest drink motion know royal",
  },
  {
    seed: { internalVersion: 0, birthdayDays: 3365, entropy: lndTestEntropy, salt: lndTestSalt },
    passphrase: "!very_safe_55345_password*",
    mnemonic:
      "able tree stool crush transfer cloud cross three profit outside hen citizen " +
      "plate ride require leg siren drum success suggest drink require fiscal upgrade",
  },
];

describe("wordlist", () => {
  it("has 2048 unique words matching the BIP39 English list endpoints", () => {
    expect(WORDLIST.length).toBe(2048);
    expect(new Set(WORDLIST).size).toBe(2048);
    expect(WORDLIST[0]).toBe("abandon");
    expect(WORDLIST[2047]).toBe("zoo");
    expect(WORD_INDEX.get("zoo")).toBe(2047);
    expect(WORD_INDEX.get("above")).toBe(4);
  });
});

describe("crc32c", () => {
  it("matches the RFC 3720 check value for '123456789'", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });
});

describe("bit packing", () => {
  it("round-trips every production vector between bytes and words", () => {
    for (const v of vectors) {
      const bytes = hex(v.enciphered_hex);
      expect(bytesToMnemonic(bytes), v.name).toEqual(v.mnemonic);
      expect(toHex(mnemonicToBytes(v.mnemonic)), v.name).toBe(v.enciphered_hex);
    }
  });
  it("round-trips random 33-byte strings", () => {
    let x = 0x12345678;
    const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0), x >>> 24);
    for (let n = 0; n < 200; n++) {
      const bytes = new Uint8Array(33).map(() => rnd());
      expect(mnemonicToBytes(bytesToMnemonic(bytes))).toEqual(bytes);
    }
  });
});

describe("lnd N=16 test vectors (cipherseed_test.go)", () => {
  for (const [i, v] of lndTestVectors.entries()) {
    it(`vector ${i} enciphers to lnd's mnemonic and deciphers back`, () => {
      const words = mnemonicFromCipherSeedSync(v.seed, v.passphrase, { scrypt: LND_TEST_SCRYPT });
      expect(words.join(" ")).toBe(v.mnemonic);
      const seed = decipherMnemonicSync(v.mnemonic, v.passphrase, { scrypt: LND_TEST_SCRYPT });
      expect(seed.birthdayDays).toBe(v.seed.birthdayDays);
      expect(seed.internalVersion).toBe(0);
      expect(seed.entropy).toEqual(lndTestEntropy);
      expect(seed.salt).toEqual(lndTestSalt);
    });
  }
  it("does not decipher with production params (documents why the fixture file exists)", () => {
    const v = lndTestVectors[0]!;
    expect(() => decipherMnemonicSync(v.mnemonic, v.passphrase)).toThrow(InvalidPassphraseError);
  });
});

describe("production vectors (lnd Go, N=32768)", () => {
  const timings: number[] = [];

  for (const v of vectors) {
    it(`${v.name}: deciphers and re-enciphers`, async () => {
      const t0 = performance.now();
      const seed = await decipherMnemonic(v.mnemonic, v.passphrase);
      timings.push(performance.now() - t0);

      expect(toHex(seed.entropy)).toBe(v.entropy_hex);
      expect(seed.birthdayDays).toBe(v.birthday_days);
      expect(seed.internalVersion).toBe(v.internal_version);
      expect(toHex(seed.salt)).toBe(v.salt_hex);

      const words = await mnemonicFromCipherSeed(seed, v.passphrase);
      expect(words).toEqual(v.mnemonic);
      expect(toHex(encipherBytesSync(seed, v.passphrase))).toBe(v.enciphered_hex);
    }, 30_000);
  }

  it("reports how long production scrypt takes here", () => {
    expect(timings.length).toBe(vectors.length);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    // Not an assertion on speed, just visibility. Fails only if absurdly slow.
    console.log(`production scrypt (N=${PRODUCTION_SCRYPT_PARAMS.N}) decipher: avg ${avg.toFixed(0)} ms over ${timings.length} runs`);
    expect(avg).toBeLessThan(20_000);
  });
});

describe("input normalisation", () => {
  const v = vectors[0]!;
  it("accepts a string with odd whitespace and capitals", async () => {
    const messy = "  " + v.mnemonic.map((w, i) => (i % 3 === 0 ? w.toUpperCase() : w)).join("\n\t  ") + " \n";
    expect(normaliseMnemonic(messy)).toEqual(v.mnemonic);
    const seed = await decipherMnemonic(messy, v.passphrase);
    expect(toHex(seed.entropy)).toBe(v.entropy_hex);
  }, 30_000);
  it("accepts an array with padded entries", () => {
    expect(normaliseMnemonic(v.mnemonic.map((w) => ` ${w} `))).toEqual(v.mnemonic);
  });
  it("is deliberately more lenient than lnd on case and padding (lnd rejects both as unknown words)", () => {
    const words = [...v.mnemonic];
    words[0] = words[0]!.toUpperCase();
    words[5] = `${words[5]!} `;
    expect(mnemonicToBytes(normaliseMnemonic(words))).toEqual(hex(v.enciphered_hex));
  });
  it("an empty word in an array is reported as an unknown word at its index, not a count error", () => {
    const words = [...v.mnemonic];
    words[23] = "";
    const err = (() => {
      try {
        decipherMnemonicSync(words);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(UnknownWordError);
    expect((err as UnknownWordError).index).toBe(23);
    expect((err as UnknownWordError).word).toBe("");
  });
  it("rejects 23 or 25 words", async () => {
    await expect(decipherMnemonic(v.mnemonic.slice(0, 23))).rejects.toBeInstanceOf(WordCountError);
    await expect(decipherMnemonic([...v.mnemonic, "zoo"])).rejects.toBeInstanceOf(WordCountError);
    expect(() => decipherMnemonicSync("")).toThrow(WordCountError);
  });
});

describe("error cases", () => {
  const v = vectors[0]!;

  it("reports an unknown word with its index and suggestions", async () => {
    const words = [...v.mnemonic];
    words[7] = "amaze";
    const err = await decipherMnemonic(words).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownWordError);
    const e = err as UnknownWordError;
    expect(e.index).toBe(7);
    expect(e.word).toBe("amaze");
    expect(e.suggestions).toEqual(["maze"]);
  });

  it("rejects a prefix of a real word (hear vs heart)", () => {
    const words = [...v.mnemonic];
    words[3] = "hear";
    expect(() => decipherMnemonicSync(words)).toThrow(UnknownWordError);
  });

  it("one wrong word in the middle gives a checksum error", async () => {
    const words = [...v.mnemonic];
    words[10] = words[10] === "zoo" ? "zebra" : "zoo";
    await expect(decipherMnemonic(words)).rejects.toBeInstanceOf(ChecksumError);
  });

  it("two swapped words give a checksum error", () => {
    const words = [...v.mnemonic];
    [words[9], words[13]] = [words[13]!, words[9]!];
    expect(words[9]).not.toBe(words[13]);
    expect(() => decipherMnemonicSync(words)).toThrow(ChecksumError);
  });

  it("a wrong first word reports the version, as lnd does, and flags the bad checksum", () => {
    const words = [...v.mnemonic];
    words[0] = "zoo"; // index 2047: top 8 bits are 0xff, so the version byte is 0xff
    const err = (() => {
      try {
        decipherMnemonicSync(words);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WrongVersionError);
    expect((err as WrongVersionError).version).toBe(0xff);
    expect((err as WrongVersionError).checksumValid).toBe(false);
  });

  it("a wrong passphrase gives InvalidPassphraseError", async () => {
    await expect(decipherMnemonic(v.mnemonic, "not the passphrase")).rejects.toBeInstanceOf(InvalidPassphraseError);
  }, 30_000);

  it("a passphrase-protected seed rejects the empty passphrase", async () => {
    const withPass = vectors.find((x) => x.passphrase.length > 0 && x.passphrase !== "aezeed")!;
    await expect(decipherMnemonic(withPass.mnemonic, "")).rejects.toBeInstanceOf(InvalidPassphraseError);
  }, 30_000);

  it("accepts a raw byte passphrase that is not valid UTF-8, as lnd's []byte API does", async () => {
    // Case 6 from the critic's differential run against lnd's Go code (production scrypt).
    // Bytes ed a0 80 are a lone UTF-16 surrogate encoded as UTF-8, which is invalid UTF-8
    // and cannot be represented losslessly as a JS string.
    const mnemonic =
      "absent vintage you whisper topple gym good tag unable spider omit cause " +
      "dove scan prison zone canal marble skill dirt vote athlete essay magic";
    const seed = await decipherMnemonic(mnemonic, hex("eda080"));
    expect(toHex(seed.entropy)).toBe("76076aec8d23a53a6932e749582667a0");
    expect(seed.birthdayDays).toBe(6930);
    expect(toHex(seed.salt)).toBe("f7299f5f5e");
    expect(toHex(encipherBytesSync(seed, hex("eda080")))).toBe(
      "00be87fcfd4e52d0191ee9ec5a366992441d806ac7fe2110f7299f5f5e1c534c2e",
    );
    // The lossy string form is a different passphrase and must be rejected.
    await expect(decipherMnemonic(mnemonic, new TextDecoder().decode(hex("eda080")))).rejects.toBeInstanceOf(
      InvalidPassphraseError,
    );
    // An empty byte array means the default passphrase, same as an empty string.
    const v0 = vectors[0]!;
    expect(toHex(decipherMnemonicSync(v0.mnemonic, new Uint8Array(0)).entropy)).toBe(v0.entropy_hex);
  }, 60_000);

  it("an explicit 'aezeed' passphrase equals the empty passphrase", async () => {
    const seed = await decipherMnemonic(v.mnemonic, "aezeed");
    expect(toHex(seed.entropy)).toBe(v.entropy_hex);
  }, 30_000);
});

describe("validateWords and suggestions", () => {
  it("flags invalid words and offers close matches", () => {
    const report = validateWords(["Abandon", "abandonn", "zo", "xyzzy", "heart", "hear"]);
    expect(report.map((r) => r.valid)).toEqual([true, false, false, false, true, false]);
    expect(report[1]!.suggestions).toContain("abandon");
    expect(report[2]!.suggestions.slice(0, 2)).toEqual(["zone", "zoo"]);
    expect(report[3]!.suggestions).toEqual([]);
    expect(report[5]!.suggestions[0]).toBe("heart");
  });
  it("suggests prefix matches before edit-distance matches", () => {
    expect(suggestWords("abov")).toEqual(["above"]);
    expect(suggestWords("acc").slice(0, 3)).toEqual(["access", "accident", "account"]);
    expect(suggestWords("zooo")).toEqual(["zoo"]);
    expect(suggestWords("")).toEqual([]);
  });
});

describe("birthday helpers", () => {
  it("maps days to dates from the genesis block", () => {
    expect(birthdayToDate(0).toISOString()).toBe("2009-01-03T18:15:05.000Z");
    // lnd test vector: 1521799345 (2018-03-23 10:02:25 UTC) is day 3365
    expect(dateToBirthday(new Date(1521799345 * 1000))).toBe(3365);
    expect(birthdayToDate(3365).getTime()).toBeLessThanOrEqual(1521799345 * 1000);
    expect(dateToBirthday(birthdayToDate(5428))).toBe(5428);
  });
});
