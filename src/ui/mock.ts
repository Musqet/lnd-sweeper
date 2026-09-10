/**
 * In-memory implementation of Ports for development and screenshots.
 * Nothing here touches the network. Loaded only in dev with ?mock.
 * A source URL containing "flaky" makes the first scan fail part way, to show recovery.
 */
import { WORDLIST, WORD_INDEX } from "../aezeed/wordlist";
import type {
  AddressTx,
  Branch,
  BranchKey,
  ChainClient,
  CipherSeed,
  DerivedAddress,
  Network,
  OwnedUtxo,
  ScanResult,
  SignedSweep,
  SweepPlan,
} from "../types";
import { EXTRA_BRANCHES, WALLET_BRANCHES, branchKey } from "../types";
import { suggestWords } from "./logic";
import { ScanFailure, UiError, type DestinationCheck, type Ports, type ScanRequest, type ScanStatus, type TxView } from "./ports";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Scan cancelled", "AbortError"));
    });
  });

function hex(n: number, seed: number): string {
  let s = "";
  let x = seed >>> 0;
  while (s.length < n) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += x.toString(16).padStart(8, "0");
  }
  return s.slice(0, n);
}

function fakeAddress(b: Branch, network: Network, index: number): string {
  const body = hex(38, index * 7 + b.change * 101 + b.purpose).replace(/[^0-9a-z]/g, "q");
  const hrp = network === "mainnet" ? "bc1" : network === "regtest" ? "bcrt1" : "tb1";
  if (b.kind === "np2wkh") return `${network === "mainnet" ? "3" : "2"}${body.slice(0, 33).toUpperCase().replace(/[0OIL]/g, "N")}`;
  return `${hrp}${b.kind === "p2wkh" ? "q" : "p"}${body.slice(0, b.kind === "p2wkh" ? 38 : 58)}`;
}

function derived(b: Branch, network: Network, index: number, coinType: 0 | 1 = 0): DerivedAddress {
  return {
    kind: b.kind,
    purpose: b.purpose,
    network,
    path: `m/${b.purpose}'/${coinType}'/0'/${b.change}/${index}`,
    change: b.change,
    index,
    address: fakeAddress(b, network, index),
    publicKey: new Uint8Array(33),
    scriptPubKey: new Uint8Array(22),
  };
}

function coinTypeOfMock(a: DerivedAddress): 0 | 1 {
  return /^m\/\d+'\/0'/.test(a.path) ? 0 : 1;
}

function sameBranch(a: DerivedAddress, b: Branch): boolean {
  return a.purpose === b.purpose && a.change === b.change && a.kind === b.kind;
}

class MockClient implements ChainClient {
  constructor(
    readonly baseUrl: string,
    readonly network: Network,
    readonly onStatus?: (s: ScanStatus) => void,
  ) {}
  async getTipHeight() {
    return 910_000;
  }
  async getAddressStats() {
    return { chainTxCount: 0, mempoolTxCount: 0, fundedSats: 0, spentSats: 0 };
  }
  async getAddressUtxos() {
    return [];
  }
  async getAddressTxs(address: string): Promise<AddressTx[]> {
    return [
      {
        txid: hex(64, address.length * 31),
        status: { confirmed: true, blockHeight: 890_123, blockTime: 1_740_000_000 },
        fee: 1_200,
        vin: [{ txid: hex(64, 9), vout: 0 }],
        vout: [{ address, value: 250_000, scriptPubKey: "0014" + hex(40, 3) }],
      },
    ];
  }
  async getFeeEstimates() {
    return { "1": 12.4, "2": 11.1, "3": 9.6, "6": 6.2, "10": 4.1, "25": 2.3, "144": 1.4 };
  }
  async broadcast(rawTxHex: string) {
    await sleep(900);
    if (this.baseUrl.includes("fail")) {
      throw new Error('sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 110 < 141"}');
    }
    return hex(64, rawTxHex.length);
  }
}

const ALL: readonly Branch[] = [...WALLET_BRANCHES, ...EXTRA_BRANCHES];
const HITS: { branch: Branch; index: number; value: number; confirmed: boolean }[] = [
  { branch: { purpose: 84, change: 0, kind: "p2wkh" }, index: 3, value: 1_250_000, confirmed: true },
  { branch: { purpose: 84, change: 0, kind: "p2wkh" }, index: 11, value: 83_420, confirmed: true },
  { branch: { purpose: 84, change: 0, kind: "p2wkh" }, index: 12, value: 40_000, confirmed: false },
  { branch: { purpose: 49, change: 1, kind: "p2wkh" }, index: 5, value: 210_000, confirmed: true },
  { branch: { purpose: 86, change: 1, kind: "p2tr" }, index: 2, value: 507_331, confirmed: true },
  // Only reachable from the second tier (window 250): a gap of 120 unused addresses.
  { branch: { purpose: 84, change: 1, kind: "p2wkh" }, index: 131, value: 66_000, confirmed: true },
];
let flakyFailures = 0;
let busyFailures = 0;

export const mockPorts: Ports = {
  checkWord(word) {
    const w = word.trim().toLowerCase();
    if (WORD_INDEX.has(w)) return { valid: true, suggestions: [] };
    return { valid: false, suggestions: suggestWords(w, WORDLIST) };
  },

  async decipher(words, passphrase) {
    await sleep(1600);
    if (words.some((w) => !WORD_INDEX.has(w.toLowerCase()))) throw new UiError("These words did not decipher.", "checksum", "mnemonic phrase checksum doesn't match");
    if (passphrase === "wrong") throw new UiError("The passphrase does not match this seed.", "passphrase", "invalid passphrase");
    return {
      internalVersion: 0,
      birthdayDays: 4_450,
      entropy: new Uint8Array(16).fill(7),
      salt: new Uint8Array(5),
    } satisfies CipherSeed;
  },

  createChainClient(baseUrl, network, onStatus) {
    return new MockClient(baseUrl, network, onStatus);
  },

  async scan(req: ScanRequest): Promise<ScanResult> {
    const prev = req.resumeFrom;
    const utxos: OwnedUtxo[] = [...(prev?.utxos ?? [])];
    const used: DerivedAddress[] = [...(prev?.usedAddresses ?? [])];
    const depth: Partial<Record<BranchKey, number>> = { ...prev?.depth };
    const coinTypes: (0 | 1)[] = req.network === "mainnet" ? [0] : [0, 1];
    const depth1: Partial<Record<BranchKey, number>> | undefined = coinTypes.includes(1) ? { ...prev?.depthCoin1 } : undefined;
    const flaky = req.client.baseUrl.includes("flaky") && flakyFailures === 0;
    const busy = req.client.baseUrl.includes("busy") && busyFailures === 0;
    const slow = req.client.baseUrl.includes("slow");
    let lookups = 0;
    const assemble = (): ScanResult => {
      const r: ScanResult = { network: req.network, utxos, usedAddresses: used, totalSats: utxos.reduce((a, u) => a + u.value, 0), depth };
      if (depth1) r.depthCoin1 = depth1;
      return r;
    };

    let branchesDone = 0;
    for (const coinType of coinTypes) {
      for (const b of ALL) {
        const key = branchKey(b);
        const table = coinType === 0 ? depth : depth1!;
        const start = table[key] ?? 0;
        let last = -1;
        for (const a of used) if (sameBranch(a, b) && coinTypeOfMock(a) === coinType && a.index > last) last = a.index;
        // A resume finishes what is unfinished to the requested window; a larger window extends every branch.
        let horizon = Math.max(last + 1 + req.window, req.window);
        if (start >= horizon) continue;
        let found = 0;
        let sats = 0;
        const batch = 50;
        for (let next = start; next < horizon; ) {
          await sleep(req.window >= 2500 ? 4 : coinType === 0 ? 60 : 25, req.signal);
          const end = Math.min(next + batch, horizon);
          lookups += end - next;
          if (flaky && branchesDone >= 2 && lookups >= 250) {
            flakyFailures += 1;
            throw new ScanFailure("HTTP 503 from the chain data source (Service Unavailable)", assemble(), false, "GET /address/…/utxo → 503 Service Unavailable after 4 attempts");
          }
          if (busy && lookups >= 150) {
            busyFailures += 1;
            throw new ScanFailure("HTTP 429 Too Many Requests", assemble(), false, "GET /address/…/utxo → 429 Too Many Requests after 4 attempts");
          }
          const status = (req.client as MockClient).onStatus;
          if (slow && status) {
            // Simulate the server asking us to slow down for a stretch: pacing, not failure.
            const paced = lookups >= 100 && lookups < 300;
            if (lookups === 100) status({ throttled: true, ratePerSecond: 4 });
            if (lookups === 300) status({ throttled: false, ratePerSecond: 8 });
            if (paced) await sleep(450, req.signal);
          }
          if (coinType === 0 && next < 250) {
            for (const hit of HITS) {
              if (hit.branch.purpose !== b.purpose || hit.branch.change !== b.change || hit.branch.kind !== b.kind) continue;
              if (hit.index < next || hit.index >= end) continue;
              const owner = derived(b, req.network, hit.index);
              used.push(owner);
              utxos.push({ txid: hex(64, hit.index * 977 + b.purpose), vout: hit.index % 2, value: hit.value, status: hit.confirmed ? { confirmed: true, blockHeight: 890_000 + hit.index, blockTime: 1_740_000_000 + hit.index * 600 } : { confirmed: false }, owner });
              found += 1;
              sats += hit.value;
              last = Math.max(last, hit.index);
              horizon = Math.max(horizon, hit.index + 1 + req.window);
            }
            if (b.purpose === 49 && b.change === 0 && next === 0) {
              used.push(derived(b, req.network, 0));
              last = 0;
              horizon = Math.max(horizon, 1 + req.window);
            }
          }
          next = end;
          table[key] = next;
          req.onProgress({ coinType, branch: b, scanned: next - start, window: req.window, lastUsedIndex: last, utxosFound: found, satsFound: sats });
        }
        branchesDone += 1;
      }
    }
    return assemble();
  },

  incompleteBranches(result, window) {
    const out: { coinType: 0 | 1; branch: Branch }[] = [];
    const passes: [0 | 1, Partial<Record<BranchKey, number>> | undefined][] = [[0, result.depth], [1, result.depthCoin1]];
    for (const [coinType, depth] of passes) {
      if (!depth) continue;
      for (const b of ALL) {
        let last = -1;
        for (const a of result.usedAddresses) if (sameBranch(a, b) && coinTypeOfMock(a) === coinType && a.index > last) last = a.index;
        if ((depth[branchKey(b)] ?? 0) < Math.max(window, last + 1 + window)) out.push({ coinType, branch: b });
      }
    }
    return out;
  },

  scanCost(network, window, resumeFrom) {
    const passes = network === "mainnet" ? 1 : 2;
    let requests = window * 7 * passes;
    if (resumeFrom) {
      for (const d of Object.values(resumeFrom.depth)) requests -= Math.min(d ?? 0, window);
      for (const d of Object.values(resumeFrom.depthCoin1 ?? {})) requests -= Math.min(d ?? 0, window);
    }
    return { requests: Math.max(0, requests), seconds: Math.ceil(Math.max(0, requests) / 8) };
  },

  async fetchTransactions(client, addresses): Promise<TxView[]> {
    const seen = new Map<string, TxView>();
    for (const a of addresses) {
      for (const tx of await client.getAddressTxs(a.address)) seen.set(tx.txid, { ...tx, netSats: tx.vout[0]?.value ?? 0 });
    }
    return [...seen.values()];
  },

  validateDestination(address, network): DestinationCheck {
    const a = address.trim();
    if (a.length === 0) return { ok: false, reason: "Enter the address you want the funds sent to." };
    const hrp = a.toLowerCase().match(/^(bc|tb|bcrt)1/)?.[1];
    if (hrp) {
      const netOf: Record<string, Network[]> = { bc: ["mainnet"], tb: ["testnet", "signet"], bcrt: ["regtest"] };
      const nets = netOf[hrp] ?? [];
      if (!nets.includes(network)) return { ok: false, reason: `This is a ${hrp === "bc" ? "mainnet" : hrp === "tb" ? "testnet or signet" : "regtest"} address, but you chose ${network}.` };
      if (a !== a.toLowerCase() && a !== a.toUpperCase()) return { ok: false, reason: "Bech32 addresses cannot mix upper and lower case." };
      const isTr = a.toLowerCase()[hrp.length + 1] === "p";
      const expected = hrp.length + 1 + (isTr ? 59 : 39);
      if (a.length !== expected) return { ok: false, reason: `Wrong length for this address type (${a.length} characters, expected ${expected}). Check for a missing or extra character.` };
      if (a.toLowerCase().endsWith("x")) return { ok: false, reason: "Invalid bech32 checksum. One or more characters are wrong." };
      return { ok: true, kind: isTr ? "Taproot address, bc1p… (P2TR)" : "Native SegWit address, bc1q… (P2WPKH)", network };
    }
    if (/^[13mn2]/.test(a)) {
      const mainnet = /^[13]/.test(a);
      if (mainnet !== (network === "mainnet")) return { ok: false, reason: `This is a ${mainnet ? "mainnet" : "test network"} address, but you chose ${network}.` };
      if (a.length < 26 || a.length > 35) return { ok: false, reason: "Wrong length for a legacy address." };
      return { ok: true, kind: /^[32]/.test(a) ? "Script address, starts with 3 (P2SH)" : "Legacy address, starts with 1 (P2PKH)", network };
    }
    return { ok: false, reason: "Not a recognised Bitcoin address. Expected it to start with bc1, 3 or 1 on mainnet." };
  },

  planSweep(inputs, destination, feeRateSatPerVb, _network, opts): SweepPlan {
    if (inputs.length === 0) throw new UiError("There is nothing to sweep: no unspent outputs were given.", "other");
    const firstUnconfirmed = inputs.findIndex((u) => !u.status.confirmed);
    if (firstUnconfirmed >= 0 && !opts?.allowUnconfirmed) {
      throw new UiError(`Input ${firstUnconfirmed + 1} is not yet confirmed. Wait for a block, or explicitly allow unconfirmed inputs.`, "unconfirmed");
    }
    const inVb = inputs.reduce((a, u) => a + (u.owner.kind === "np2wkh" ? 91 : u.owner.kind === "p2wkh" ? 68 : 57.5), 0);
    const outVb = destination.toLowerCase().startsWith("bc1p") || destination.toLowerCase().startsWith("tb1p") ? 43 : 31;
    const estimatedVsize = Math.ceil(10.5 + inVb + outVb);
    const feeSats = Math.ceil(estimatedVsize * feeRateSatPerVb);
    const total = inputs.reduce((a, u) => a + u.value, 0);
    if (feeSats >= total) {
      throw new UiError(`The fee of ${feeSats} sats at ${feeRateSatPerVb} sat/vB is more than the ${total} sats being swept, so there would be nothing left to send. Lower the fee rate.`, "dust");
    }
    const outputSats = total - feeSats;
    if (outputSats < 546) throw new UiError(`After the fee of ${feeSats} sats the output would be ${outputSats} sats, below the 546 sat dust limit. Lower the fee rate.`, "dust");
    if (!opts?.allowHighFee && feeSats > total * 0.2) {
      throw new UiError(`The fee of ${feeSats} sats is ${((feeSats / total) * 100).toFixed(1)}% of the ${total} sats being swept, above the 20% limit. Lower the fee rate, or confirm you accept a high fee.`, "fee-too-large");
    }
    return { inputs, destination, feeRateSatPerVb, estimatedVsize, feeSats, outputSats };
  },

  async signSweep(plan, _seed, _network): Promise<SignedSweep> {
    await sleep(700);
    const rawTxHex = "02000000000101" + hex(plan.inputs.length * 120 + 200, plan.feeSats);
    return { ...plan, txid: hex(64, plan.outputSats), rawTxHex, vsize: plan.estimatedVsize - 1 };
  },
};
