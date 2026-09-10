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
import { deriveAddress, deriveKey, masterFromEntropy } from "../keys";
import { SweepError, planSweep, signSweep } from "../tx";
import type { Network } from "../types";
import { suggestWords } from "./logic";
import { ScanFailure, UiError, coinTypeOfPath, type Ports } from "./ports";

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

  incompleteBranches(result, window) {
    return incompleteBranches(result, window);
  },

  scanCost(network, window, resumeFrom) {
    const { requests } = estimateScanCost(network, { window, ...(resumeFrom ? { resumeFrom } : {}) });
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
