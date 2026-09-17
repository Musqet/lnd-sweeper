/**
 * Binds the UI's Ports to the real modules.
 */
import {
  ChecksumError,
  InvalidPassphraseError,
  UnknownWordError,
  WORDLIST,
  WORD_INDEX,
  WordCountError,
  WrongVersionError,
  decipherMnemonic,
} from "../aezeed";
import { validateDestination, type DestinationKind } from "../address";
import { EsploraClient, EsploraError, RotatingChainClient, ScanError, estimateScanCost, estimateScanSeconds, fetchTransactions, incompleteBranches, isAbortError, scan } from "../chain";
import { deriveAddress, deriveBranchAddresses, deriveKey, masterFromEntropy, rootXprv } from "../keys";
import { SweepError, planSweep, signSweep } from "../tx";
import { EXTRA_BRANCHES, WALLET_BRANCHES, walletCoinTypesFor, type AddressKind, type Network } from "../types";
import { suggestWords } from "./logic";
import { ScanFailure, UiError, coinTypeOfPath, type FindAddressResult, type Ports } from "./ports";

/** Wallet script kinds that can produce a given destination script type; other kinds lnd never pays to on its wallet branches. */
const WALLET_KINDS_FOR_DEST: Partial<Record<DestinationKind, readonly AddressKind[]>> = {
  p2tr: ["p2tr"],
  p2wpkh: ["p2wkh"],
  p2sh: ["np2wkh"],
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const KIND_LABEL: Record<DestinationKind, string> = {
  p2pkh: "Legacy address, starts with 1 (P2PKH)",
  p2sh: "Script address, starts with 3 (P2SH)",
  p2wpkh: "Native SegWit address, bc1q… (P2WPKH)",
  p2wsh: "Native SegWit script address, long bc1q… (P2WSH)",
  p2tr: "Taproot address, bc1p… (P2TR)",
};

function toUiError(e: unknown): UiError {
  if (e instanceof UiError) return e;
  if (e instanceof InvalidPassphraseError) return new UiError("The passphrase does not match this seed.", "passphrase", e.message);
  if (e instanceof ChecksumError || e instanceof WrongVersionError) return new UiError("These words did not decipher.", "checksum", e.message);
  if (e instanceof UnknownWordError || e instanceof WordCountError) return new UiError(e.message, "words", e.message);
  if (e instanceof SweepError) {
    const code =
      e.code === "fee-too-large" ? "fee-too-large"
      : e.code === "dust" || e.code === "fee-exceeds-total" ? "dust"
      : e.code === "unconfirmed-input" ? "unconfirmed"
      : e.code === "plan-tampered" ? "plan-tampered"
      : "other";
    return new UiError(e.message, code);
  }
  if (e instanceof EsploraError) {
    const status = e.status ? ` (HTTP ${e.status})` : "";
    return new UiError(`${e.message}${status}`, "network", e.body || e.url);
  }
  if (isAbortError(e)) return new UiError("Cancelled", "other");
  if (e instanceof Error) return new UiError(e.message || e.name, "other");
  return new UiError(String(e), "other");
}

export const realPorts: Ports = {
  checkWord(word) {
    const w = word.trim().toLowerCase();
    if (WORD_INDEX.has(w)) return { valid: true, suggestions: [] };
    return { valid: false, suggestions: suggestWords(w, WORDLIST) };
  },

  async decipher(words, passphrase) {
    try {
      return await decipherMnemonic(words, passphrase);
    } catch (e) {
      throw toUiError(e);
    }
  },

  createChainClient(sources, network, onStatus) {
    const urls = Array.isArray(sources) ? sources : [sources];
    if (urls.length > 1) {
      return new RotatingChainClient(urls, {
        network,
        ...(onStatus
          ? {
              onStatus: (ev) => {
                // The rotating client only emits "switch"; all-cooling means every
                // server is busy, which is the moment to show the slow-down note.
                if (ev.kind === "switch") onStatus({ throttled: ev.allCooling, server: ev.server });
              },
            }
          : {}),
      });
    }
    return new EsploraClient(urls[0]!, {
      network,
      ...(onStatus
        ? {
            onStatus: (ev) => {
              // Retries are routine; only pacing changes are worth telling the user about.
              if (ev.kind === "slow-down") onStatus({ throttled: true, ratePerSecond: ev.ratePerSecond });
              else if (ev.kind === "recovered") onStatus({ throttled: false, ratePerSecond: ev.ratePerSecond });
            },
          }
        : {}),
    });
  },

  async scan(req) {
    const master = masterFromEntropy(req.seed.entropy);
    try {
      return await scan(
        (coinType, branch, index) => deriveAddress(master, req.network, branch, index, { coinType }),
        req.client,
        req.network,
        {
          window: req.window,
          onProgress: req.onProgress,
          ...(req.resumeFrom ? { resumeFrom: req.resumeFrom } : {}),
          ...(req.branches ? { branches: req.branches } : {}),
          ...(req.coinTypes ? { coinTypes: req.coinTypes } : {}),
          ...(req.startFrom ? { startFrom: req.startFrom } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        },
      );
    } catch (e) {
      if (e instanceof ScanError) {
        const inner = toUiError(e.cause);
        throw new ScanFailure(inner.message, e.partial, e.aborted, inner.detail);
      }
      throw toUiError(e);
    } finally {
      master.wipePrivateData();
    }
  },

  async findAddress(req): Promise<FindAddressResult> {
    const val = validateDestination(req.target, req.network);
    if (!val.ok) return { found: false, reason: "invalid", detail: val.reason };
    const wantKinds = WALLET_KINDS_FOR_DEST[val.kind];
    if (!wantKinds) {
      return { found: false, reason: "not-wallet-kind", detail: `${val.kind.toUpperCase()} is not a script type lnd's wallet derives (it uses P2SH-wrapped SegWit, native SegWit and Taproot).` };
    }
    const target = val.scriptPubKey;
    const branches = [...WALLET_BRANCHES, ...EXTRA_BRANCHES].filter((b) => wantKinds.includes(b.kind));
    const coinTypes = walletCoinTypesFor(req.network);
    const perBranch = req.maxIndex + 1;
    const total = perBranch * branches.length * coinTypes.length;
    const chunk = 1024;
    const master = masterFromEntropy(req.seed.entropy);
    try {
      let scanned = 0;
      for (const coinType of coinTypes) {
        for (const b of branches) {
          for (let start = 0; start <= req.maxIndex; start += chunk) {
            if (req.signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
            const count = Math.min(chunk, req.maxIndex - start + 1);
            const addrs = deriveBranchAddresses(master, req.network, b, start, count, { coinType });
            for (const a of addrs) if (bytesEqual(a.scriptPubKey, target)) return { found: true, owner: a };
            scanned += count;
            req.onProgress?.(scanned, total);
            // Yield so the progress bar paints and the search stays cancellable.
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      }
      return { found: false, reason: "exhausted" };
    } finally {
      master.wipePrivateData();
    }
  },

  masterXprv(seed, network) {
    return rootXprv(seed.entropy, network);
  },

  incompleteBranches(result, window, branches) {
    // Passing `branches` undefined falls through to the chain function's default (all wallet branches).
    return incompleteBranches(result, window, branches);
  },

  scanCost(network, window, resumeFrom, opts) {
    const { requests } = estimateScanCost(network, {
      window,
      ...(resumeFrom ? { resumeFrom } : {}),
      ...(opts?.branches ? { branches: opts.branches } : {}),
      ...(opts?.coinTypes ? { coinTypes: opts.coinTypes } : {}),
      ...(opts?.startFrom ? { startFrom: opts.startFrom } : {}),
    });
    return { requests, seconds: estimateScanSeconds(requests) };
  },

  async fetchTransactions(client, addresses, signal) {
    try {
      return await fetchTransactions(client, addresses, signal ? { signal } : {});
    } catch (e) {
      throw toUiError(e);
    }
  },

  validateDestination(address, network: Network) {
    const r = validateDestination(address, network);
    if (!r.ok) return r;
    return { ok: true, kind: KIND_LABEL[r.kind], network };
  },

  planSweep(inputs, destination, feeRateSatPerVb, _network, opts) {
    try {
      return planSweep(inputs, destination, feeRateSatPerVb, {
        ...(opts?.tipHeight !== undefined ? { tipHeight: opts.tipHeight } : {}),
        ...(opts?.allowHighFee ? { allowHighFee: true } : {}),
        ...(opts?.allowUnconfirmed ? { allowUnconfirmed: true } : {}),
      });
    } catch (e) {
      throw toUiError(e);
    }
  },

  async signSweep(plan, seed, network) {
    const master = masterFromEntropy(seed.entropy);
    try {
      // Yield once so the spinner paints before the synchronous signing work.
      await new Promise((r) => setTimeout(r, 0));
      return signSweep(plan, (owner) =>
        deriveKey(master, network, { purpose: owner.purpose, change: owner.change, kind: owner.kind }, owner.index, { coinType: coinTypeOfPath(owner.path) }),
      );
    } catch (e) {
      throw toUiError(e);
    } finally {
      master.wipePrivateData();
    }
  },
};
