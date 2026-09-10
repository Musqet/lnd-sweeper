/**
 * Thin wrapper around chantools (guggero/chantools) used as an independent
 * oracle for aezeed decoding and lnd key derivation.
 *
 * chantools reads the seed from AEZEED_MNEMONIC and AEZEED_PASSPHRASE
 * ("-" means no passphrase). genimportscript --format bitcoin-descriptors
 * emits one `importdescriptors` line per key index, each carrying three
 * descriptors for the same key: sh(wpkh(..)) (np2wkh), wpkh(..) (p2wkh) and
 * tr(..) (p2tr), with the address as the label. With --derivationpath the
 * first `window` lines are the external branch (change 0) and the next
 * `window` lines are the internal branch (change 1); verified against
 * bitcoind deriveaddresses in the e2e test.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressKind, Network } from "../../../src/types";
import { PURPOSE_FOR_KIND, coinTypeFor } from "../../../src/types";
import { makeTempDir, removeDir } from "./util";

export interface BranchAddresses {
  /** Addresses in the path's own encoding (np2wkh for 49, p2wkh for 84, p2tr for 86). */
  external: string[];
  internal: string[];
  /**
   * chantools emits sh(wpkh()), wpkh() and tr() for every key. Keep all three so
   * callers can check lnd's BIP0049Plus internal branch (m/49'/.../1/i encoded as
   * native P2WPKH) against the wpkh label of the 49 path.
   */
  encodings: { external: Record<AddressKind, string[]>; internal: Record<AddressKind, string[]> };
}

export type ChantoolsAddresses = Record<AddressKind, BranchAddresses>;

/** Locate chantools: CHANTOOLS_BIN, then PATH, then the known scratchpad location. */
export function chantoolsBin(): string {
  const env = process.env["CHANTOOLS_BIN"];
  if (env) return env;
  const scratch =
    "/private/tmp/claude-501/-Users-richhenderson-code-musqet-lnd-sweeper/2b0bc49e-ae76-4b1e-8e88-3fd9f0f658e8/scratchpad/tools/chantools-darwin-arm64-v0.14.2/chantools";
  if (existsSync(scratch)) return scratch;
  return "chantools";
}

const NETWORK_FLAG: Record<Network, string[]> = {
  mainnet: [],
  testnet: ["--testnet"],
  signet: ["--signet"],
  regtest: ["--regtest"],
};

async function run(mnemonic: string[], passphrase: string | undefined, args: string[]): Promise<string> {
  const cwd = makeTempDir("chantools");
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        chantoolsBin(),
        ["--nologfile", ...args],
        {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            AEZEED_MNEMONIC: mnemonic.join(" "),
            AEZEED_PASSPHRASE: passphrase && passphrase.length > 0 ? passphrase : "-",
          },
        },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`chantools ${args.join(" ")}: ${stderr || stdout || err.message}`));
          else resolve(stdout + stderr);
        },
      );
    });
  } finally {
    removeDir(cwd);
  }
}

/** BIP32 root key (xprv on mainnet, tprv elsewhere) as chantools computes it from the words. */
export async function showRootKey(
  mnemonic: string[],
  passphrase: string | undefined,
  network: Network = "regtest",
): Promise<string> {
  const out = await run(mnemonic, passphrase, [...NETWORK_FLAG[network], "showrootkey"]);
  const m = /root key is:\s*([a-zA-Z0-9]+)/.exec(out);
  if (!m?.[1]) throw new Error(`could not parse showrootkey output:\n${out}`);
  return m[1];
}

interface DescriptorEntry {
  desc: string;
  label: string;
}

function parseDescriptorLines(out: string): DescriptorEntry[][] {
  const rows: DescriptorEntry[][] = [];
  for (const line of out.split("\n")) {
    const m = /importdescriptors '(\[.*\])'\s*$/.exec(line.trim());
    if (!m?.[1]) continue;
    rows.push(JSON.parse(m[1]) as DescriptorEntry[]);
  }
  return rows;
}

function pickLabel(row: DescriptorEntry[], kind: AddressKind): string {
  const prefix = kind === "np2wkh" ? "sh(wpkh(" : kind === "p2wkh" ? "wpkh(" : "tr(";
  const e = row.find((d) => d.desc.startsWith(prefix));
  if (!e) throw new Error(`chantools row has no ${kind} descriptor: ${JSON.stringify(row)}`);
  return e.label;
}

/**
 * Addresses chantools derives for one purpose path, both branches, `window` each.
 * Path used: m/purpose'/coinType'/0' with /0/i and /1/i appended by chantools.
 */
export async function genImportScriptForKind(
  mnemonic: string[],
  passphrase: string | undefined,
  kind: AddressKind,
  window: number,
  network: Network = "regtest",
): Promise<BranchAddresses> {
  const path = `m/${PURPOSE_FOR_KIND[kind]}'/${coinTypeFor(network)}'/0'`;
  const out = await run(mnemonic, passphrase, [
    ...NETWORK_FLAG[network],
    "genimportscript",
    "--format",
    "bitcoin-descriptors",
    "--derivationpath",
    path,
    "--recoverywindow",
    String(window),
    "--stdout",
  ]);
  const rows = parseDescriptorLines(out);
  if (rows.length !== 2 * window) {
    throw new Error(`chantools emitted ${rows.length} keys for ${path}, expected ${2 * window}:\n${out.slice(0, 2000)}`);
  }
  const labels = rows.map((r) => pickLabel(r, kind));
  const enc = (slice: DescriptorEntry[][]): Record<AddressKind, string[]> => ({
    np2wkh: slice.map((r) => pickLabel(r, "np2wkh")),
    p2wkh: slice.map((r) => pickLabel(r, "p2wkh")),
    p2tr: slice.map((r) => pickLabel(r, "p2tr")),
  });
  return {
    external: labels.slice(0, window),
    internal: labels.slice(window),
    encodings: { external: enc(rows.slice(0, window)), internal: enc(rows.slice(window)) },
  };
}

/** All three lnd purposes, both branches. */
export async function genImportScript(
  mnemonic: string[],
  passphrase: string | undefined,
  window = 25,
  network: Network = "regtest",
): Promise<ChantoolsAddresses> {
  const kinds: AddressKind[] = ["np2wkh", "p2wkh", "p2tr"];
  const out = {} as ChantoolsAddresses;
  for (const kind of kinds) {
    out[kind] = await genImportScriptForKind(mnemonic, passphrase, kind, window, network);
  }
  return out;
}

/** Path string in the same shape as DerivedAddress.path for cross-checking. */
export function pathFor(kind: AddressKind, network: Network, change: 0 | 1, index: number): string {
  return join(`m/${PURPOSE_FOR_KIND[kind]}'/${coinTypeFor(network)}'/0'`, String(change), String(index));
}
