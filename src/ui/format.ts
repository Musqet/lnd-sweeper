import type { AddressKind, Network } from "../types";

const GENESIS_MS = Date.UTC(2009, 0, 3);

export function formatSats(sats: number): string {
  return `${Math.round(sats).toLocaleString("en-GB")} sats`;
}

/** 0.01234567 BTC with thin-space grouping after the decimal point, as wallets do. */
export function formatBtc(sats: number): string {
  const neg = sats < 0 ? "-" : "";
  const abs = Math.abs(Math.round(sats));
  const whole = Math.floor(abs / 1e8);
  const frac = String(abs % 1e8).padStart(8, "0");
  return `${neg}${whole.toLocaleString("en-GB")}.${frac.slice(0, 2)} ${frac.slice(2, 5)} ${frac.slice(5)} BTC`;
}

export function birthdayDate(birthdayDays: number): string {
  const d = new Date(GENESIS_MS + birthdayDays * 86_400_000);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export const KIND_LABEL: Record<AddressKind, string> = {
  np2wkh: "Nested SegWit",
  p2wkh: "Native SegWit",
  p2tr: "Taproot",
};

/** Script-type wording for a branch row, e.g. "native SegWit (bc1q…)". */
export function scriptLabel(kind: AddressKind, network: Network): string {
  const name = kind === "np2wkh" ? "nested SegWit" : kind === "p2wkh" ? "native SegWit" : "Taproot";
  return `${name} (${kindPrefix(kind, network)})`;
}

/**
 * Module error messages carry raw integers ("2727000 sats"). Format every
 * "<n> sats" with separators, adding BTC for anything from 0.001 BTC up.
 */
export function formatSatsInText(text: string): string {
  return text.replace(/\b(\d{4,})(\s+sats?)\b/g, (_m, n: string, unit: string) => {
    const v = Number(n);
    const withSep = `${v.toLocaleString("en-GB")}${unit}`;
    return v >= 100_000 ? `${withSep} (${formatBtc(v)})` : withSep;
  });
}

export const KIND_PATH: Record<AddressKind, string> = {
  np2wkh: "m/49'",
  p2wkh: "m/84'",
  p2tr: "m/86'",
};

export function kindPrefix(kind: AddressKind, network: Network): string {
  const hrp = network === "mainnet" ? "bc1" : network === "regtest" ? "bcrt1" : "tb1";
  if (kind === "np2wkh") return network === "mainnet" ? "3..." : "2...";
  return kind === "p2wkh" ? `${hrp}q...` : `${hrp}p...`;
}

export const NETWORK_LABEL: Record<Network, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
  signet: "Signet",
  regtest: "Regtest",
};

export function shortId(s: string, head = 8, tail = 8): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Plain-words message from any thrown value. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "Unknown error";
  }
}
