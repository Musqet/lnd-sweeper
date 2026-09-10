import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { validateDestination, type DestinationKind } from "../../src/address";
import type { Network } from "../../src/types";

const NETWORKS: Network[] = ["mainnet", "testnet", "signet", "regtest"];
const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
function btcNet(n: Network) {
  return n === "mainnet" ? btc.NETWORK : n === "regtest" ? REGTEST : btc.TEST_NETWORK;
}

// Deterministic keys so the generated addresses are stable across runs.
const KEYS = [1, 2, 3, 4, 5].map((i) => hexToBytes(i.toString(16).padStart(64, "0")));

interface Sample {
  network: Network;
  kind: DestinationKind;
  address: string;
  script: Uint8Array;
}

function generated(): Sample[] {
  const out: Sample[] = [];
  for (const network of NETWORKS) {
    const net = btcNet(network);
    for (const priv of KEYS) {
      const pub = btc.utils.pubSchnorr(priv); // x-only for p2tr
      const pubc = new Uint8Array(33);
      pubc[0] = 0x02;
      pubc.set(pub, 1);
      const pkh = btc.p2pkh(pubc, net);
      const sh = btc.p2sh(btc.p2wpkh(pubc, net), net);
      const wpkh = btc.p2wpkh(pubc, net);
      const wsh = btc.p2wsh(btc.p2pkh(pubc, net), net);
      const tr = btc.p2tr(pub, undefined, net);
      out.push(
        { network, kind: "p2pkh", address: pkh.address!, script: pkh.script },
        { network, kind: "p2sh", address: sh.address!, script: sh.script },
        { network, kind: "p2wpkh", address: wpkh.address!, script: wpkh.script },
        { network, kind: "p2wsh", address: wsh.address!, script: wsh.script },
        { network, kind: "p2tr", address: tr.address!, script: tr.script },
      );
    }
  }
  return out;
}

// Hand-picked real addresses: BIP173/BIP350 vectors, Bitcoin Core docs, chantools fixtures.
const KNOWN: { network: Network; kind: DestinationKind; address: string }[] = [
  { network: "mainnet", kind: "p2pkh", address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2" },
  { network: "mainnet", kind: "p2sh", address: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy" },
  { network: "mainnet", kind: "p2wpkh", address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" },
  { network: "mainnet", kind: "p2wpkh", address: "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4" },
  { network: "mainnet", kind: "p2wsh", address: "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3" },
  { network: "mainnet", kind: "p2tr", address: "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0" },
  { network: "testnet", kind: "p2pkh", address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn" },
  { network: "testnet", kind: "p2sh", address: "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc" },
  { network: "testnet", kind: "p2wsh", address: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7" },
  { network: "testnet", kind: "p2tr", address: "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c" },
  // chantools signet fixtures (random1-default.signet.*)
  { network: "signet", kind: "p2sh", address: "2N7RopW6eiXf8fyUL1Wd4RJN8ieAmaxL2bG" },
  // chantools regtest fixtures (random1-default.regtest.49)
  { network: "regtest", kind: "p2sh", address: "2N7RopW6eiXf8fyUL1Wd4RJN8ieAmaxL2bG" },
  { network: "regtest", kind: "p2wpkh", address: "bcrt1qce2h7amnjmwxsvk60g8thr4kqzk4uvlyzdmgxl" },
  { network: "regtest", kind: "p2tr", address: "bcrt1plzyepv0fq0gcjujqn7ec2a0d7zm83aym3l6g9zqnumez4zs9lcuq5fv44n" },
];

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Minimal bech32/bech32m encoder, used only to build deliberately mis-encoded vectors. */
function bech32Encode(hrp: string, version: number, program: Uint8Array, m: boolean): string {
  const words = [version];
  let acc = 0;
  let bits = 0;
  for (const b of program) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values: number[]) => {
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
    }
    return chk >>> 0;
  };
  const exp = [...hrp].map((c) => c.charCodeAt(0) >>> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod([...exp, ...words, 0, 0, 0, 0, 0, 0]) ^ (m ? 0x2bc830a3 : 1);
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...checksum].map((w) => BECH32_CHARSET[w]!).join("");
}

const BASE58_CHARSET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Every one-character substitution of the payload (not the HRP or separator). */
function typos(address: string): string[] {
  const isBech = /^(bc|tb|bcrt)1/i.test(address);
  const start = isBech ? address.lastIndexOf("1") + 1 : 0;
  const out: string[] = [];
  for (let i = start; i < address.length; i++) {
    const c = address[i]!;
    const charset = isBech
      ? c === c.toUpperCase() && c !== c.toLowerCase()
        ? BECH32_CHARSET.toUpperCase()
        : BECH32_CHARSET
      : BASE58_CHARSET;
    // Replace with a different character from the same alphabet (deterministic choice).
    const idx = charset.indexOf(c);
    const alt = charset[(idx + 7) % charset.length]!;
    out.push(address.slice(0, i) + alt + address.slice(i + 1));
  }
  return out;
}

describe("validateDestination: accepts real addresses", () => {
  for (const s of generated()) {
    it(`${s.network} ${s.kind} ${s.address}`, () => {
      const r = validateDestination(s.address, s.network);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.kind).toBe(s.kind);
      expect(bytesToHex(r.scriptPubKey)).toBe(bytesToHex(s.script));
    });
  }
  for (const k of KNOWN) {
    it(`${k.network} ${k.kind} ${k.address}`, () => {
      const r = validateDestination(k.address, k.network);
      expect(r).toMatchObject({ ok: true, kind: k.kind });
      if (r.ok) {
        // Cross-check the script against @scure/btc-signer's decoder.
        const decoded = btc.Address(btcNet(k.network)).decode(k.address);
        expect(bytesToHex(r.scriptPubKey)).toBe(bytesToHex(btc.OutScript.encode(decoded)));
      }
    });
  }
  it("does not trim: any whitespace anywhere is rejected (the UI trims before calling)", () => {
    for (const bad of [" bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 ", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4\n", "\tbc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7 kv8f3t4", " 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2\r\n", "\u00a0bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"]) {
      const r = validateDestination(bad, "mainnet");
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("rejects non-ASCII look-alikes before case folding (Kelvin sign, Cyrillic, fullwidth)", () => {
    // U+212A KELVIN SIGN lower-cases to ASCII 'k' via toLowerCase(); Core rejects it, so must we.
    const kelvin = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7\u212Av8f3t4";
    expect(kelvin.toLowerCase()).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"); // the trap
    const r = validateDestination(kelvin, "mainnet");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/character/i);
    const upperKelvin = "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7\u212AV8F3T4";
    expect(validateDestination(upperKelvin, "mainnet").ok).toBe(false);
    expect(validateDestination("1BvBMSEYstWetqTFn5\u0430u4m4GFg7xJaNVN2", "mainnet").ok).toBe(false); // Cyrillic a
    expect(validateDestination("\uff42c1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "mainnet").ok).toBe(false); // fullwidth b
    expect(validateDestination("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4\u200b", "mainnet").ok).toBe(false); // zero-width space
  });
});

describe("validateDestination: rejects every one-character typo", () => {
  const all = [...generated(), ...KNOWN];
  for (const s of all) {
    it(`${s.network} ${s.kind} ${s.address}`, () => {
      for (const bad of typos(s.address)) {
        const r = validateDestination(bad, s.network);
        expect(r.ok, `${bad} must be rejected`).toBe(false);
        if (!r.ok) expect(r.reason).not.toMatch(/—/); // no em-dashes
      }
    });
  }
});

describe("validateDestination: wrong network", () => {
  it("mainnet bech32 given on regtest names the network", () => {
    const r = validateDestination("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "regtest");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/mainnet address.*regtest/);
  });
  it("regtest bech32 given on mainnet names the network", () => {
    const r = validateDestination("bcrt1qce2h7amnjmwxsvk60g8thr4kqzk4uvlyzdmgxl", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/regtest address.*mainnet/);
  });
  it("testnet bech32 given on regtest says testnet or signet", () => {
    const r = validateDestination("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "regtest");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/testnet or signet address.*regtest/);
  });
  it("mainnet legacy given on regtest", () => {
    const r = validateDestination("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "regtest");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/mainnet address.*regtest/);
  });
  it("testnet legacy given on mainnet", () => {
    const r = validateDestination("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/testnet, signet or regtest address.*mainnet/);
  });
  it("legacy test-network addresses are accepted on testnet, signet and regtest alike", () => {
    for (const n of ["testnet", "signet", "regtest"] as Network[]) {
      expect(validateDestination("2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc", n).ok).toBe(true);
    }
  });
  it("signet bech32 is accepted on testnet and vice versa (shared tb prefix)", () => {
    expect(validateDestination("tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", "signet").ok).toBe(true);
  });
});

describe("validateDestination: specific reasons", () => {
  it("bad checksum (bech32)", () => {
    const r = validateDestination("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/checksum/i);
  });
  it("bad checksum (base58)", () => {
    const r = validateDestination("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/checksum/i);
  });
  it("mixed case bech32", () => {
    const r = validateDestination("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3T4", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/mixes upper and lower case/i);
  });
  it("bech32 used where bech32m is required (witness v1) - BIP350 vector", () => {
    const r = validateDestination("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/must use bech32m encoding/i);
    expect(r.reason).toMatch(/version 1/i);
  });
  it("bech32 used where bech32m is required (witness v1) - constructed on every network", () => {
    for (const s of generated().filter((g) => g.kind === "p2tr")) {
      const hrp = s.address.slice(0, s.address.lastIndexOf("1"));
      const bad = bech32Encode(hrp, 1, s.script.subarray(2), false);
      expect(bad).not.toBe(s.address);
      const r = validateDestination(bad, s.network);
      if (r.ok) throw new Error(`accepted ${bad}`);
      expect(r.reason).toMatch(/must use bech32m encoding/i);
    }
  });
  it("bech32m used where bech32 is required (witness v0) - constructed on every network", () => {
    for (const s of generated().filter((g) => g.kind === "p2wpkh" || g.kind === "p2wsh")) {
      const hrp = s.address.slice(0, s.address.lastIndexOf("1"));
      const good = bech32Encode(hrp, 0, s.script.subarray(2), false);
      expect(good).toBe(s.address); // encoder sanity check
      const bad = bech32Encode(hrp, 0, s.script.subarray(2), true);
      const r = validateDestination(bad, s.network);
      if (r.ok) throw new Error(`accepted ${bad}`);
      expect(r.reason).toMatch(/must use bech32 encoding/i);
      expect(r.reason).toMatch(/version 0/i);
    }
  });
  it("bech32m with a valid v16 program is a valid address but not sendable", () => {
    // BIP350 valid vector, witness v16 2-byte program.
    const r = validateDestination("BC1SW50QGDZ25J", "mainnet");
    expect(r.ok).toBe(false);
  });
  it("unknown witness version", () => {
    // BIP350 valid vector: witness v16, 2-byte program. Valid encoding, but not sendable here.
    const r = validateDestination("BC1SW50QGDZ25J", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/witness version 16/i);
  });
  it("future witness versions 2..16 are valid to Core but refused here with a plain warning (deliberate divergence)", () => {
    // Bitcoin Core's validateaddress reports isvalid=true for any bech32m address with witness
    // version 1..16 and a 2..40 byte program, because the consensus rules leave them spendable by
    // anyone until a soft fork defines them. We deliberately refuse: no such address type is in
    // use on Bitcoin today, so a user pasting one has almost certainly made a mistake, and coins
    // sent there could be taken by anyone or lost. The reason must say so in plain words.
    for (const version of [2, 3, 7, 15, 16]) {
      for (const len of [2, 20, 32, 40]) {
        const program = new Uint8Array(len).map((_, i) => (i * 37 + version) & 0xff);
        for (const [hrp, network] of [["bc", "mainnet"], ["tb", "testnet"], ["bcrt", "regtest"]] as const) {
          const addr = bech32Encode(hrp, version, program, true);
          const r = validateDestination(addr, network);
          if (r.ok) throw new Error(`accepted ${addr}`);
          expect(r.reason, addr).toMatch(new RegExp(`witness version ${version}`));
          expect(r.reason, addr).toMatch(/not yet in use on Bitcoin/);
          expect(r.reason, addr).toMatch(/lose/);
        }
      }
    }
  });
  it("v1 with a non-32-byte program and P2A are refused with the same plain warning", () => {
    // BIP350 valid vector: v1, 40-byte program.
    const r = validateDestination("bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/not yet in use on Bitcoin|not a Taproot address/);
    expect(r.reason).toMatch(/lose/);
    // BIP433 pay-to-anchor, witness v1 program 0x4e73: anyone can spend it.
    const p2a = bech32Encode("bc", 1, new Uint8Array([0x4e, 0x73]), true);
    expect(p2a).toBe("bc1pfeessrawgf");
    const r2 = validateDestination(p2a, "mainnet");
    if (r2.ok) throw new Error("accepted");
    expect(r2.reason).toMatch(/anyone/i);
    expect(r2.reason).toMatch(/lose/);
  });
  it("invalid witness program length", () => {
    // BIP350 invalid vector: v0 with a 21-byte program (not 20 or 32).
    const r = validateDestination("bc1qr508d6qejxtdg4y5r3zarvaryv98gj9p", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/length/i);
  });
  it("v1 with non-32-byte program is rejected", () => {
    // BIP350 valid vector: v1, 40-byte program, bech32m.
    const r = validateDestination("bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/40-byte program/);
    expect(r.reason).toMatch(/32 bytes/);
  });
  it("unsupported legacy version byte", () => {
    // Valid base58check with Litecoin's P2SH version byte 0x32 (an "M..." address).
    const ltc = { bech32: "ltc", pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
    const pubc = new Uint8Array([0x02, ...btc.utils.pubSchnorr(KEYS[0]!)]);
    const foreign = btc.p2sh(btc.p2wpkh(pubc, ltc), ltc).address!;
    expect(foreign.startsWith("M")).toBe(true);
    const r = validateDestination(foreign, "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/not a supported|unsupported/i);
  });
  it("invalid characters", () => {
    const r = validateDestination("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN0", "mainnet");
    if (r.ok) throw new Error("accepted");
    expect(r.reason).toMatch(/character/i);
    const r2 = validateDestination("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3tb", "mainnet");
    if (r2.ok) throw new Error("accepted");
    expect(r2.reason).toMatch(/character/i);
  });
  it("empty and nonsense", () => {
    expect(validateDestination("", "mainnet").ok).toBe(false);
    expect(validateDestination("   ", "mainnet").ok).toBe(false);
    expect(validateDestination("hello world", "mainnet").ok).toBe(false);
    expect(validateDestination("ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "mainnet").ok).toBe(false);
  });
  it("never accepts a checksum failure on any network", () => {
    for (const n of NETWORKS) {
      expect(validateDestination("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", n).ok).toBe(false);
      expect(validateDestination("bcrt1qce2h7amnjmwxsvk60g8thr4kqzk4uvlyzdmgxx", n).ok).toBe(false);
      expect(validateDestination("2N7RopW6eiXf8fyUL1Wd4RJN8ieAmaxL2bH", n).ok).toBe(false);
    }
  });
});
