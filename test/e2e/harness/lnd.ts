/**
 * Throwaway lnd on regtest, backed by the harness bitcoind.
 *
 * We never use --noseedbackup: the point of the e2e test is a real aezeed. The
 * wallet is created over REST with GenSeed + InitWallet (fresh seed) or with
 * InitWallet on a mnemonic we supply (restore path). Macaroons and TLS are read
 * from the lnddir.
 */
import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { AddressKind } from "../../../src/types";
import type { Bitcoind } from "./bitcoind";
import {
  FatalError,
  freePort,
  killHard,
  makeTempDir,
  removeDir,
  spawnDaemon,
  stopProcess,
  waitFor,
  type Managed,
} from "./util";

export interface LndOpts {
  bitcoind: Bitcoind;
  bin?: string;
  lncliBin?: string;
  /** Supply a mnemonic to restore instead of generating a fresh one. */
  mnemonic?: string[];
  /** aezeed passphrase (cipher seed passphrase), NOT the wallet password. */
  aezeedPassphrase?: string;
  /** Wallet unlock password. Fixed default; it never matters for recovery. */
  walletPassword?: string;
  /** Only meaningful with `mnemonic`: address lookahead for the restore rescan. */
  recoveryWindow?: number;
  echo?: boolean;
  lnddir?: string;
}

/** lnrpc.AddressType numeric values. */
const ADDRESS_TYPE: Record<AddressKind, number> = { p2wkh: 0, np2wkh: 1, p2tr: 4 };
const UNUSED_ADDRESS_TYPE: Record<AddressKind, number> = { p2wkh: 2, np2wkh: 3, p2tr: 5 };
/** walletrpc.AddressType names for WalletKit.NextAddr. */
const WALLETKIT_TYPE: Record<AddressKind, string> = {
  p2wkh: "WITNESS_PUBKEY_HASH",
  np2wkh: "NESTED_WITNESS_PUBKEY_HASH",
  p2tr: "TAPROOT_PUBKEY",
};

export interface LndUtxo {
  /** lnrpc.AddressType name as lnd reports it, e.g. WITNESS_PUBKEY_HASH, NESTED_PUBKEY_HASH, TAPROOT_PUBKEY. */
  addressType: string;
  address: string;
  amountSat: number;
  pkScript: string;
  txid: string;
  vout: number;
  confirmations: number;
}

export interface LndBalance {
  confirmedSat: number;
  unconfirmedSat: number;
  totalSat: number;
}

export type ChangeType = "p2wkh" | "p2tr";

export interface Lnd {
  readonly pid: number | undefined;
  readonly lnddir: string;
  readonly restUrl: string;
  readonly rpcHost: string;
  readonly mnemonic: string[];
  readonly aezeedPassphrase: string | undefined;
  readonly walletPassword: string;
  /** Authenticated REST call. Enums may be passed as numbers or names. */
  rest<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
  lncli(args: string[]): Promise<string>;
  getInfo(): Promise<{ synced_to_chain: boolean; block_height: number; identity_pubkey: string }>;
  waitSynced(minHeight?: number): Promise<void>;
  newAddress(kind: AddressKind): Promise<string>;
  /** Returns the current unused address on the external branch without advancing the index. */
  unusedAddress(kind: AddressKind): Promise<string>;
  /**
   * WalletKit.NextAddr on the default account. With change=true this hands out
   * the next INTERNAL-branch address of that key scope. Note the BIP0049Plus
   * quirk: the nested scope's internal branch is encoded as native P2WPKH.
   */
  nextAddr(kind: AddressKind, change: boolean): Promise<string>;
  walletBalance(): Promise<LndBalance>;
  /** lncli listunspent equivalent (confirmed only by default). */
  listUnspent(minConfs?: number): Promise<LndUtxo[]>;
  /** Plain SendCoins. lnd picks the inputs; change goes to the P2TR internal branch (lnd >= 0.15). Returns txid. */
  sendCoins(addr: string, sats: number, satPerVb?: number): Promise<string>;
  /**
   * Spend exactly the given UTXOs to `addr` via FundPsbt/FinalizePsbt/PublishTransaction,
   * choosing the change branch. This is how we force real change onto the
   * internal branch of both the BIP84 and BIP86 paths. Returns txid.
   */
  spendUtxos(
    inputs: { txid: string; vout: number }[],
    addr: string,
    sats: number,
    changeType: ChangeType,
    satPerVb?: number,
  ): Promise<{ txid: string; rawTxHex: string }>;
  /** Graceful shutdown; does not remove the data dir. */
  stop(): Promise<void>;
  /** SIGKILL, like pulling the plug. */
  kill(): Promise<void>;
  /** Remove the whole lnddir so recovery has nothing to go on but the seed. */
  deleteDataDir(): void;
}

/** Known drop location for a hash-verified lnd release used when nothing is on PATH. */
const SCRATCH_LND_DIR =
  "/private/tmp/claude-501/-Users-richhenderson-code-musqet-lnd-sweeper/2b0bc49e-ae76-4b1e-8e88-3fd9f0f658e8/scratchpad/tools/lnd-darwin-arm64-v0.21.3-beta";

/** LND_BIN, else the scratchpad release if present, else PATH. lnd < 0.18.4 cannot talk to Core >= 28 without -deprecatedrpc=warnings. */
export function lndBin(): string {
  const env = process.env["LND_BIN"];
  if (env) return env;
  const scratch = join(SCRATCH_LND_DIR, "lnd");
  return existsSync(scratch) ? scratch : "lnd";
}

export function lncliBinPath(): string {
  const env = process.env["LNCLI_BIN"];
  if (env) return env;
  const scratch = join(SCRATCH_LND_DIR, "lncli");
  return existsSync(scratch) ? scratch : "lncli";
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

export async function startLnd(opts: LndOpts): Promise<Lnd> {
  const bin = opts.bin ?? lndBin();
  const lncliBin = opts.lncliBin ?? lncliBinPath();
  const walletPassword = opts.walletPassword ?? "e2e-wallet-password";
  const lnddir = opts.lnddir ?? makeTempDir("lnd-sweeper-lnd");
  const [rpcPort, restPort] = await Promise.all([freePort(), freePort()]);
  const rpcHost = `127.0.0.1:${rpcPort}`;
  const restUrl = `https://127.0.0.1:${restPort}`;
  const tlsCertPath = join(lnddir, "tls.cert");
  const macaroonPath = join(lnddir, "data", "chain", "bitcoin", "regtest", "admin.macaroon");
  const { bitcoind } = opts;
  const { user: rpcUser, pass: rpcPass } = bitcoind.auth();

  const args = [
    `--lnddir=${lnddir}`,
    "--bitcoin.regtest",
    "--bitcoin.node=bitcoind",
    `--bitcoind.rpchost=127.0.0.1:${bitcoind.rpcPort}`,
    `--bitcoind.rpcuser=${rpcUser}`,
    `--bitcoind.rpcpass=${rpcPass}`,
    `--bitcoind.zmqpubrawblock=${bitcoind.zmqPubRawBlock}`,
    `--bitcoind.zmqpubrawtx=${bitcoind.zmqPubRawTx}`,
    "--bitcoind.estimatemode=ECONOMICAL",
    `--rpclisten=${rpcHost}`,
    `--restlisten=127.0.0.1:${restPort}`,
    "--nolisten",
    "--nobootstrap",
    "--debuglevel=info",
    // Regtest fee estimation from bitcoind always fails; keep the fallback sane.
    "--bitcoin.defaultchanconfs=1",
  ];
  const managed: Managed = spawnDaemon(bin, args, { echo: opts.echo ?? false });
  const fail = (msg: string): Error => new FatalError(`${msg}\n--- lnd output (tail) ---\n${managed.log().slice(-6000)}`);

  let ca: Buffer | undefined;
  const loadCa = (): Buffer => {
    if (!ca) ca = readFileSync(tlsCertPath);
    return ca;
  };
  let macaroonHex: string | undefined;
  const loadMacaroon = (): string | undefined => {
    if (!macaroonHex && existsSync(macaroonPath)) macaroonHex = readFileSync(macaroonPath).toString("hex");
    return macaroonHex;
  };

  const rawRest = <T,>(method: string, path: string, body?: unknown, withMacaroon = true): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (withMacaroon) {
        const mac = loadMacaroon();
        if (mac) headers["Grpc-Metadata-macaroon"] = mac;
      }
      const req = httpsRequest(
        `${restUrl}${path}`,
        { method, headers, ca: loadCa(), rejectUnauthorized: true, servername: "localhost" },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              reject(new Error(`lnd ${method} ${path}: HTTP ${res.statusCode} non-JSON: ${text.slice(0, 300)}`));
              return;
            }
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const msg = (parsed as { message?: string; error?: string }).message ?? text;
              reject(new Error(`lnd ${method} ${path}: HTTP ${status}: ${msg}`));
              return;
            }
            resolve(parsed as T);
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  const state = async (): Promise<string> => {
    const r = await rawRest<{ state: string }>("GET", "/v1/state", undefined, false);
    return r.state;
  };

  // 1. Wait for the TLS cert and the wallet-unlocker REST to come up.
  await waitFor(
    "lnd REST (wallet unlocker)",
    async () => {
      if (managed.exited()) throw fail("lnd exited during startup");
      if (!existsSync(tlsCertPath)) return undefined;
      const s = await state();
      return s === "NON_EXISTING" ? s : undefined;
    },
    { timeoutMs: 90_000, intervalMs: 300 },
  ).catch((e: unknown) => {
    if (e instanceof FatalError) throw e;
    throw fail(e instanceof Error ? e.message : String(e));
  });

  // 2. Create the wallet from a fresh or supplied aezeed.
  let mnemonic = opts.mnemonic;
  const passphraseB64 = opts.aezeedPassphrase ? b64(opts.aezeedPassphrase) : undefined;
  if (!mnemonic) {
    const q = passphraseB64 ? `?aezeed_passphrase=${encodeURIComponent(passphraseB64)}` : "";
    const seed = await rawRest<{ cipher_seed_mnemonic: string[] }>("GET", `/v1/genseed${q}`, undefined, false);
    mnemonic = seed.cipher_seed_mnemonic;
    if (mnemonic.length !== 24) throw new Error(`GenSeed returned ${mnemonic.length} words`);
  }
  const initBody: Record<string, unknown> = {
    wallet_password: b64(walletPassword),
    cipher_seed_mnemonic: mnemonic,
  };
  if (passphraseB64) initBody["aezeed_passphrase"] = passphraseB64;
  if (opts.mnemonic && opts.recoveryWindow !== undefined) initBody["recovery_window"] = opts.recoveryWindow;
  await rawRest("POST", "/v1/initwallet", initBody, false);

  // 3. Wait for the main RPC server and the admin macaroon.
  await waitFor(
    "lnd SERVER_ACTIVE",
    async () => {
      if (managed.exited()) throw fail("lnd exited after InitWallet");
      const s = await state();
      return s === "SERVER_ACTIVE" && loadMacaroon() ? s : undefined;
    },
    { timeoutMs: 120_000, intervalMs: 300 },
  ).catch((e: unknown) => {
    if (e instanceof FatalError) throw e;
    throw fail(e instanceof Error ? e.message : String(e));
  });

  const rest = <T,>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> =>
    rawRest<T>(method, path, body, true);

  const lncli = (cliArgs: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        lncliBin,
        ["--network=regtest", `--lnddir=${lnddir}`, `--rpcserver=${rpcHost}`, ...cliArgs],
        { maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`lncli ${cliArgs.join(" ")}: ${stderr || err.message}`));
          else resolve(stdout);
        },
      );
    });

  const getInfo = (): Promise<{ synced_to_chain: boolean; block_height: number; identity_pubkey: string }> =>
    rest("GET", "/v1/getinfo");

  const decodeTxid = async (rawHex: string): Promise<string> => {
    const d = await bitcoind.rpc<{ txid: string }>("decoderawtransaction", [rawHex]);
    return d.txid;
  };

  const lnd: Lnd = {
    pid: managed.proc.pid,
    lnddir,
    restUrl,
    rpcHost,
    mnemonic,
    aezeedPassphrase: opts.aezeedPassphrase,
    walletPassword,
    rest,
    lncli,
    getInfo,
    async waitSynced(minHeight) {
      const target = minHeight ?? (await bitcoind.blockHeight());
      await waitFor(
        `lnd synced_to_chain at height >= ${target}`,
        async () => {
          if (managed.exited()) throw fail("lnd exited while syncing");
          const i = await getInfo();
          return i.synced_to_chain && Number(i.block_height) >= target ? true : undefined;
        },
        { timeoutMs: 120_000, intervalMs: 300 },
      );
    },
    async newAddress(kind) {
      const r = await rest<{ address: string }>("GET", `/v1/newaddress?type=${ADDRESS_TYPE[kind]}`);
      return r.address;
    },
    async unusedAddress(kind) {
      const r = await rest<{ address: string }>("GET", `/v1/newaddress?type=${UNUSED_ADDRESS_TYPE[kind]}`);
      return r.address;
    },
    async nextAddr(kind, change) {
      const r = await rest<{ addr: string }>("POST", "/v2/wallet/address/next", {
        account: "",
        type: WALLETKIT_TYPE[kind],
        change,
      });
      return r.addr;
    },
    async walletBalance() {
      const r = await rest<{ confirmed_balance: string; unconfirmed_balance: string; total_balance: string }>(
        "GET",
        "/v1/balance/blockchain",
      );
      return {
        confirmedSat: Number(r.confirmed_balance),
        unconfirmedSat: Number(r.unconfirmed_balance),
        totalSat: Number(r.total_balance),
      };
    },
    async listUnspent(minConfs = 1) {
      const r = await rest<{
        utxos: {
          address_type: string | number;
          address: string;
          amount_sat: string;
          pk_script: string;
          outpoint: { txid_str: string; output_index: number };
          confirmations: string;
        }[];
      }>("GET", `/v1/utxos?min_confs=${minConfs}&max_confs=2147483647`);
      return (r.utxos ?? []).map((u) => ({
        addressType: String(u.address_type),
        address: u.address,
        amountSat: Number(u.amount_sat),
        pkScript: u.pk_script,
        txid: u.outpoint.txid_str,
        vout: Number(u.outpoint.output_index),
        confirmations: Number(u.confirmations),
      }));
    },
    async sendCoins(addr, sats, satPerVb = 2) {
      const r = await rest<{ txid: string }>("POST", "/v1/transactions", {
        addr,
        amount: String(sats),
        sat_per_vbyte: String(satPerVb),
        min_confs: 1,
      });
      return r.txid;
    },
    async spendUtxos(inputs, addr, sats, changeType, satPerVb = 2) {
      const fund = await rest<{ funded_psbt: string; change_output_index: number }>("POST", "/v2/wallet/psbt/fund", {
        raw: {
          inputs: inputs.map((i) => ({ txid_str: i.txid, output_index: i.vout })),
          outputs: { [addr]: String(sats) },
        },
        sat_per_vbyte: String(satPerVb),
        min_confs: 1,
        change_type: changeType === "p2tr" ? "CHANGE_ADDRESS_TYPE_P2TR" : "CHANGE_ADDRESS_TYPE_UNSPECIFIED",
      });
      if (fund.change_output_index < 0) {
        throw new Error("FundPsbt produced no change output; lower the send amount so change is created");
      }
      const fin = await rest<{ raw_final_tx: string }>("POST", "/v2/wallet/psbt/finalize", {
        funded_psbt: fund.funded_psbt,
      });
      const rawTxHex = Buffer.from(fin.raw_final_tx, "base64").toString("hex");
      const pub = await rest<{ publish_error: string }>("POST", "/v2/wallet/tx", { tx_hex: fin.raw_final_tx });
      if (pub.publish_error) throw new Error(`PublishTransaction: ${pub.publish_error}`);
      return { txid: await decodeTxid(rawTxHex), rawTxHex };
    },
    async stop() {
      try {
        if (!managed.exited()) await rest("POST", "/v1/stop", {});
      } catch {
        /* fall through */
      }
      await stopProcess(managed.proc, 30_000);
    },
    kill: () => killHard(managed.proc),
    deleteDataDir: () => removeDir(lnddir),
  };
  return lnd;
}
