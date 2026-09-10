/**
 * Regtest proof for planSweep + signSweep against a real bitcoind.
 *
 * Starts a throwaway bitcoind -regtest on a random port in a temp datadir, funds chantools
 * fixture addresses of all three lnd wallet kinds on both branches, sweeps them with our
 * code to a fresh bitcoind address at 2 sat/vB, and lets bitcoind judge the result.
 *
 * Self-contained on purpose: this file must not depend on other agents' harness code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { planSweep, signSweep } from "../../src/tx";
import type { AddressKind, DerivedAddress, OwnedUtxo } from "../../src/types";
import { fixtureAddress, fixtureKeys, keyRing, type FixtureKey } from "../unit/tx-fixtures";

const BITCOIND = process.env.BITCOIND ?? (existsSync("/opt/homebrew/bin/bitcoind") ? "/opt/homebrew/bin/bitcoind" : "bitcoind");
const RPC_USER = "sweeper";
const RPC_PASS = "regtest-only";
const WALLET = "miner";
const FEE_RATE = 2;

let child: ChildProcess | undefined;
let datadir: string | undefined;
let rpcPort = 0;
let minerAddress = "";
let rpcId = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return reject(new Error("no port"));
      srv.close(() => resolve(addr.port));
    });
  });
}

async function rpc<T = unknown>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
  const url = `http://127.0.0.1:${rpcPort}/${wallet ? `wallet/${WALLET}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${RPC_USER}:${RPC_PASS}`)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let body: { result?: T; error?: { code: number; message: string } | null };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}
const wrpc = <T = unknown>(method: string, params: unknown[] = []) => rpc<T>(method, params, true);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toSats = (btc: number) => Math.round(btc * 1e8);
const toBtc = (sats: number) => (sats / 1e8).toFixed(8);

interface Unspent {
  txid: string;
  vout: number;
  scriptPubKey: string;
  amount: number;
  height: number;
}

async function scan(addresses: string[]): Promise<Unspent[]> {
  const r = await rpc<{ success: boolean; unspents: Unspent[] }>("scantxoutset", ["start", addresses.map((a) => `addr(${a})`)]);
  expect(r.success).toBe(true);
  return r.unspents;
}

async function mine(n = 1): Promise<number> {
  await rpc("generatetoaddress", [n, minerAddress]);
  return rpc<number>("getblockcount");
}

beforeAll(async () => {
  rpcPort = await freePort();
  const p2pPort = await freePort();
  datadir = mkdtempSync(join(tmpdir(), "lnd-sweeper-regtest-"));
  child = spawn(
    BITCOIND,
    [
      "-regtest",
      `-datadir=${datadir}`,
      "-server=1",
      "-listen=0",
      `-port=${p2pPort}`,
      `-rpcport=${rpcPort}`,
      "-rpcbind=127.0.0.1",
      "-rpcallowip=127.0.0.1",
      `-rpcuser=${RPC_USER}`,
      `-rpcpassword=${RPC_PASS}`,
      "-fallbackfee=0.0001",
      "-dnsseed=0",
      "-printtoconsole=0",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`bitcoind exited early with code ${child.exitCode}`);
    try {
      await rpc("getblockchaininfo");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("bitcoind did not come up within 60s");
      await sleep(200);
    }
  }
  await rpc("createwallet", [WALLET]);
  minerAddress = await wrpc<string>("getnewaddress");
  await mine(101);
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    try {
      await rpc("stop");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([exited, sleep(20_000).then(() => child!.kill("SIGKILL"))]);
  }
  if (datadir) rmSync(datadir, { recursive: true, force: true });
});

interface Funded {
  key: FixtureKey;
  owner: DerivedAddress;
  sats: number;
}

/** Sends the given amounts to the owners in one wallet transaction and mines it. */
async function fund(targets: { key: FixtureKey; owner: DerivedAddress; sats: number }[]): Promise<Funded[]> {
  const outputs: Record<string, string> = {};
  for (const t of targets) {
    if (outputs[t.owner.address]) throw new Error(`duplicate funding address ${t.owner.address}`);
    outputs[t.owner.address] = toBtc(t.sats);
  }
  await wrpc("sendmany", ["", outputs]);
  await mine(1);
  return targets;
}

async function utxosFor(funded: Funded[]): Promise<OwnedUtxo[]> {
  const unspents = await scan(funded.map((f) => f.owner.address));
  const byScript = new Map(funded.map((f) => [bytesToHex(f.owner.scriptPubKey), f]));
  const out: OwnedUtxo[] = [];
  for (const u of unspents) {
    const f = byScript.get(u.scriptPubKey);
    if (!f) throw new Error(`unexpected script ${u.scriptPubKey}`);
    out.push({ txid: u.txid, vout: u.vout, value: toSats(u.amount), status: { confirmed: true, blockHeight: u.height }, owner: f.owner });
  }
  expect(out).toHaveLength(funded.length);
  for (const f of funded) {
    const mine = out.filter((u) => u.owner.address === f.owner.address);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.value).toBe(f.sats);
  }
  return out;
}

interface Outcome {
  inputs: number;
  kinds: string;
  destType: string;
  estimatedVsize: number;
  vsize: number;
  feeSats: number;
  effectiveRate: number;
}
const outcomes: Outcome[] = [];

/** The full sweep proof for one composition. */
async function proveSweep(funded: Funded[], destType: "legacy" | "p2sh-segwit" | "bech32" | "bech32m"): Promise<void> {
  const utxos = await utxosFor(funded);
  const total = utxos.reduce((s, u) => s + u.value, 0);
  const destination = await wrpc<string>("getnewaddress", ["", destType]);
  const tip = await rpc<number>("getblockcount");

  const plan = planSweep(utxos, destination, FEE_RATE, { tipHeight: tip });
  expect(plan.lockTime).toBe(tip);
  const signed = signSweep(plan, keyRing(funded).keyFor);

  // 1. bitcoind's mempool policy check agrees with our fee and size.
  const accept = await rpc<{ txid: string; allowed: boolean; vsize?: number; fees?: { base: number }; "reject-reason"?: string }[]>("testmempoolaccept", [[signed.rawTxHex]]);
  expect(accept).toHaveLength(1);
  expect(accept[0]!.allowed, accept[0]!["reject-reason"]).toBe(true);
  expect(accept[0]!.txid).toBe(signed.txid);
  expect(toSats(accept[0]!.fees!.base)).toBe(signed.feeSats);
  expect(accept[0]!.vsize).toBe(signed.vsize);

  // 2. It broadcasts, and the mempool sees the same size and fee.
  const txid = await rpc<string>("sendrawtransaction", [signed.rawTxHex]);
  expect(txid).toBe(signed.txid);
  const entry = await rpc<{ vsize: number; fees: { base: number } }>("getmempoolentry", [txid]);
  expect(entry.vsize).toBe(signed.vsize);
  expect(toSats(entry.fees.base)).toBe(signed.feeSats);

  // 3. After mining, the destination holds total minus fee and the swept addresses are empty.
  await mine(1);
  const destUnspents = await scan([destination]);
  expect(destUnspents).toHaveLength(1);
  expect(destUnspents[0]!.txid).toBe(signed.txid);
  expect(toSats(destUnspents[0]!.amount)).toBe(total - signed.feeSats);
  expect(toSats(destUnspents[0]!.amount)).toBe(signed.outputSats);
  expect(await scan(funded.map((f) => f.owner.address))).toHaveLength(0);

  // 4. The confirmed transaction is byte-for-byte ours, with the size we reported.
  const blockHash = await rpc<string>("getbestblockhash");
  const confirmed = await rpc<{ hex: string; vsize: number; weight: number; locktime: number; version: number; vin: { sequence: number }[] }>("getrawtransaction", [txid, true, blockHash]);
  expect(confirmed.hex).toBe(signed.rawTxHex);
  expect(confirmed.vsize).toBe(signed.vsize);
  expect(confirmed.vsize).toBeLessThanOrEqual(signed.estimatedVsize);
  expect(confirmed.locktime).toBe(tip);
  expect(confirmed.version).toBe(2);
  for (const vin of confirmed.vin) expect(vin.sequence).toBe(0xfffffffd);

  // 5. Effective fee rate is at or above what was asked for.
  const effectiveRate = signed.feeSats / signed.vsize;
  expect(effectiveRate).toBeGreaterThanOrEqual(FEE_RATE);

  outcomes.push({
    inputs: utxos.length,
    kinds: summarise(utxos.map((u) => u.owner.kind)),
    destType,
    estimatedVsize: signed.estimatedVsize,
    vsize: signed.vsize,
    feeSats: signed.feeSats,
    effectiveRate: Math.round(effectiveRate * 1000) / 1000,
  });
}

function summarise(kinds: AddressKind[]): string {
  const c: Record<string, number> = {};
  for (const k of kinds) c[k] = (c[k] ?? 0) + 1;
  return Object.entries(c)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

// Fixture keys: lnd uses coin type 0 on every network. Index 0..24 external, 25..49 internal.
const K = {
  np2wkh: fixtureKeys("random1-default", "regtest", 49),
  p2wkh: fixtureKeys("random1-default", "regtest", 84),
  p2tr: fixtureKeys("random1-default", "regtest", 86),
};
function target(kind: AddressKind, line: number, sats: number) {
  const key = K[kind][line]!;
  return { key, owner: fixtureAddress(key, kind), sats };
}

describe("regtest sweep", () => {
  it("mixed kinds on both branches -> bech32", async () => {
    const funded = await fund([
      target("np2wkh", 0, 150_000), // external
      target("np2wkh", 25, 250_000), // internal
      target("p2wkh", 1, 1_000_000),
      target("p2wkh", 26, 33_333),
      target("p2tr", 2, 5_000_000),
      target("p2tr", 27, 12_345),
    ]);
    expect(funded.map((f) => f.owner.change)).toEqual([0, 1, 0, 1, 0, 1]);
    await proveSweep(funded, "bech32");
  });

  it("single p2tr input -> bech32m", async () => {
    await proveSweep(await fund([target("p2tr", 3, 700_000)]), "bech32m");
  });

  it("single np2wkh input -> legacy", async () => {
    await proveSweep(await fund([target("np2wkh", 4, 420_000)]), "legacy");
  });

  it("single p2wkh input -> p2sh-segwit", async () => {
    await proveSweep(await fund([target("p2wkh", 5, 99_999)]), "p2sh-segwit");
  });

  it("25 mixed inputs -> p2sh-segwit", async () => {
    const kinds: AddressKind[] = ["np2wkh", "p2wkh", "p2tr"];
    const targets = [];
    for (let i = 0; i < 25; i++) {
      // Lines 6..14 external and 28..43 internal, spread across kinds, no address reused above.
      const line = i < 9 ? 6 + i : 28 + (i - 9);
      targets.push(target(kinds[i % 3]!, line, 20_000 + i * 7_919));
    }
    await proveSweep(await fund(targets), "p2sh-segwit");
  });

  it("summary", () => {
    expect(outcomes).toHaveLength(5);
    console.log("\nregtest sweep outcomes (requested 2 sat/vB):");
    for (const o of outcomes) {
      console.log(`  ${String(o.inputs).padStart(2)} inputs (${o.kinds}) -> ${o.destType}: estimate ${o.estimatedVsize} vB, actual ${o.vsize} vB, fee ${o.feeSats} sats, ${o.effectiveRate} sat/vB`);
    }
  });
});
