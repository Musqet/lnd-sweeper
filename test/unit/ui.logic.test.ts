import { describe, expect, it } from "vitest";
import { confirmGate, confirmSlice, distributeWords, explorerRoot, feePercent, pickFee, splitPhrase, suggestWords, txUrl } from "../../src/ui/logic";

const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

describe("word distribution", () => {
  it("spreads a full 24-word paste from box 0 regardless of focus", () => {
    const cur = Array.from({ length: 24 }, () => "");
    const { words, focus } = distributeWords(cur, PHRASE, 7);
    expect(words).toEqual(PHRASE.split(" "));
    expect(focus).toBe(23);
  });

  it("fills a partial paste from the focused box onwards and stops at 24", () => {
    const cur = Array.from({ length: 24 }, (_, i) => (i < 20 ? `w${i}` : ""));
    const { words, focus } = distributeWords(cur, "one two three four five six", 20);
    expect(words.slice(20)).toEqual(["one", "two", "three", "four"]);
    expect(words[19]).toBe("w19");
    expect(focus).toBe(23);
  });

  it("accepts numbered, newline and comma separated phrases and lower-cases", () => {
    expect(splitPhrase("1. Abandon\n2) ability,3 able\t4- about")).toEqual(["abandon", "ability", "able", "about"]);
  });

  it("leaves words alone on an empty paste", () => {
    const cur = ["a", "b"];
    expect(distributeWords(cur, "   ", 1).words.slice(0, 2)).toEqual(["a", "b"]);
  });
});

describe("confirmation gate", () => {
  const bech = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  const base58 = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";

  it("splits off the last six characters for display", () => {
    expect(confirmSlice(bech)).toEqual({ head: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7k", tail: "v8f3t4" });
  });

  it("requires the last six characters exactly", () => {
    expect(confirmGate(bech, "v8f3t4").ok).toBe(true);
    expect(confirmGate(bech, "v8f3t").ok).toBe(false);
    expect(confirmGate(bech, "bc1qw5").ok).toBe(false);
  });

  it("reports a mismatch as soon as the typed prefix cannot match", () => {
    expect(confirmGate(bech, "v8f").mismatch).toBe(false);
    expect(confirmGate(bech, "v9").mismatch).toBe(true);
    expect(confirmGate(bech, "").mismatch).toBe(false);
  });

  it("is case-insensitive for bech32 but exact for base58", () => {
    expect(confirmGate(bech, "V8F3T4").ok).toBe(true);
    expect(confirmGate(base58, "RhWNLy").ok).toBe(true);
    expect(confirmGate(base58, "rhwnly").ok).toBe(false);
    expect(confirmGate(base58, "rhwnly").mismatch).toBe(true);
  });

  it("never passes for a short destination", () => {
    expect(confirmGate("bc1q", "bc1q").ok).toBe(false);
  });
});

describe("helpers", () => {
  it("suggests prefix matches first, then near misses", () => {
    const list = ["abandon", "ability", "able", "about", "above", "absent"];
    expect(suggestWords("ab", list, 3)).toEqual(["abandon", "ability", "able"]);
    expect(suggestWords("abov", list)).toEqual(["above"]);
    expect(suggestWords("abxve", list)[0]).toBe("above");
    expect(suggestWords("zzzzzz", list)).toEqual([]);
  });

  it("turns an API base into explorer links", () => {
    expect(explorerRoot("https://mempool.space/api/")).toBe("https://mempool.space");
    expect(txUrl("https://mempool.space/signet/api", "ab")).toBe("https://mempool.space/signet/tx/ab");
    expect(txUrl("http://127.0.0.1:3000", "ab")).toBe("http://127.0.0.1:3000/tx/ab");
  });

  it("formats the fee as a share of the total", () => {
    expect(feePercent(1_879, 1_880_751)).toBe("0.10%");
    expect(feePercent(20_000, 100_000)).toBe("20.0%");
    expect(feePercent(5, 0)).toBe("0%");
  });

  it("picks fee presets from Esplora estimates", () => {
    const est = { "1": 12.44, "3": 9.6, "6": 6.2, "144": 1.4 };
    expect(pickFee(est, "fast")).toBe(12.4);
    expect(pickFee(est, "medium")).toBe(6.2);
    expect(pickFee(est, "slow")).toBe(1.4);
    expect(pickFee({}, "fast")).toBeUndefined();
  });
});
