/**
 * Pure UI logic, kept free of DOM so it can be unit tested.
 */
import { publicServerUrls } from "../chain";
import type { Network } from "../types";

export const WORD_COUNT = 24;

/** Split any pasted text into lower-case words. Accepts numbering like "1. word" or "1) word". */
export function splitPhrase(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\r\n,;\t]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^\d+[.):-]?$/, "").replace(/^\d+[.):-]/, ""))
    .filter((w) => w.length > 0);
}

/**
 * Paste handling. If the pasted text holds several words, fill from the focused
 * box onwards (or from box 0 when the paste holds a full phrase). Returns the new
 * word array (length WORD_COUNT) and which box should receive focus next.
 */
export function distributeWords(
  current: readonly string[],
  pasted: string,
  focusedIndex: number,
): { words: string[]; focus: number } {
  const words = Array.from({ length: WORD_COUNT }, (_, i) => current[i] ?? "");
  const incoming = splitPhrase(pasted);
  if (incoming.length === 0) return { words, focus: focusedIndex };
  const start = incoming.length >= WORD_COUNT ? 0 : focusedIndex;
  let i = 0;
  for (; i < incoming.length && start + i < WORD_COUNT; i++) {
    words[start + i] = incoming[i]!;
  }
  const next = Math.min(start + i, WORD_COUNT - 1);
  return { words, focus: next };
}

/** How many of the 24 boxes hold something. */
export function filledCount(words: readonly string[]): number {
  return words.filter((w) => w.trim().length > 0).length;
}

/** Levenshtein distance, small strings only. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

/** Up to `max` suggestions for a misspelt word: prefix matches first, then near misses. */
export function suggestWords(word: string, list: readonly string[], max = 4): string[] {
  const w = word.toLowerCase();
  if (w.length === 0) return [];
  const out: string[] = [];
  for (const c of list) {
    if (c.startsWith(w) && c !== w) out.push(c);
    if (out.length >= max) return out;
  }
  const near = list
    .filter((c) => !out.includes(c) && c !== w)
    .map((c) => ({ c, d: editDistance(w, c) }))
    .filter((x) => x.d <= (w.length <= 4 ? 1 : 2))
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .map((x) => x.c);
  for (const c of near) {
    if (out.length >= max) break;
    out.push(c);
  }
  return out;
}

export const CONFIRM_CHARS = 6;

/** The part of the destination the user must retype: its last CONFIRM_CHARS characters (the checksum end, where typos hide). */
export function confirmSlice(destination: string): { head: string; tail: string } {
  return { head: destination.slice(0, -CONFIRM_CHARS), tail: destination.slice(-CONFIRM_CHARS) };
}

/**
 * The confirmation gate. `ok` once the typed text equals the tail exactly
 * (case-insensitive for bech32, exact for base58); `mismatch` as soon as what
 * has been typed so far cannot become the tail, so the UI can say so.
 */
export function confirmGate(destination: string, typed: string): { ok: boolean; expected: string; mismatch: boolean } {
  const expected = confirmSlice(destination).tail;
  const t = typed.trim();
  if (destination.length < CONFIRM_CHARS) return { ok: false, expected, mismatch: t.length > 0 };
  const bech = /^(bc1|tb1|bcrt1)/i.test(destination);
  const norm = (x: string) => (bech ? x.toLowerCase() : x);
  const ok = norm(t) === norm(expected);
  const mismatch = t.length > 0 && !norm(expected).startsWith(norm(t));
  return { ok, expected, mismatch };
}

/** Fee as a percentage of the total, one decimal, for display. */
export function feePercent(feeSats: number, totalSats: number): string {
  if (totalSats <= 0) return "0%";
  const pct = (feeSats / totalSats) * 100;
  return `${pct < 0.1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

/** Default Esplora-style API base URL per network. */
export const DEFAULT_SOURCE: Record<Network, string> = {
  mainnet: "https://mempool.space/api",
  testnet: "https://mempool.space/testnet4/api",
  signet: "https://mempool.space/signet/api",
  regtest: "http://127.0.0.1:3000",
};

/** Whether this network has a trusted public server set to spread across. */
export function hasTrustedServers(network: Network): boolean {
  return publicServerUrls(network).length > 0;
}

/**
 * The server URLs a scan should query: the trusted public set (rotated across)
 * when chosen and available, otherwise just the custom URL.
 */
export function chainSources(network: Network, useTrusted: boolean, customUrl: string): string[] {
  if (useTrusted) {
    const trusted = publicServerUrls(network);
    if (trusted.length > 0) return trusted;
  }
  return [customUrl.replace(/\/+$/, "")];
}

/** The URL to build explorer links from: the first trusted server, or the custom URL. */
export function explorerSource(network: Network, useTrusted: boolean, customUrl: string): string {
  return chainSources(network, useTrusted, customUrl)[0]!;
}

/** Explorer web root for a chain API URL: strip a trailing /api, keep the network path. */
export function explorerRoot(apiBase: string): string {
  return apiBase.replace(/\/+$/, "").replace(/\/api$/, "");
}

export function txUrl(apiBase: string, txid: string): string {
  return `${explorerRoot(apiBase)}/tx/${txid}`;
}

export function addressUrl(apiBase: string, address: string): string {
  return `${explorerRoot(apiBase)}/address/${address}`;
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Pick a fee rate from Esplora estimates for a named speed. Falls back sensibly. */
export function pickFee(estimates: Record<string, number>, speed: "fast" | "medium" | "slow"): number | undefined {
  const target = speed === "fast" ? ["1", "2", "3"] : speed === "medium" ? ["6", "5", "4", "3"] : ["144", "72", "25", "24", "12"];
  for (const t of target) {
    const v = estimates[t];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.max(1, Math.round(v * 10) / 10);
  }
  return undefined;
}
