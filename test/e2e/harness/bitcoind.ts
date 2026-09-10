/**
 * Throwaway regtest bitcoind for e2e tests.
 *
 * Temp datadir, free ports, cookie auth, txindex=1, ZMQ raw block/tx publishers
 * (needed by lnd's bitcoind backend), -fallbackfee so the miner wallet can send.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  FatalError,
  btcToSats,
  freePort,
  killHard,
  makeTempDir,
  removeDir,
  spawnDaemon,
  stopProcess,
  waitFor,
  type Managed,
} from "./util";

export interface BitcoindOpts {
  bin?: string;
  cliBin?: string;
  /** Name of the descriptor wallet used for mining and funding. */
  walletName?: string;
  /** Echo daemon output to stderr. */
  echo?: boolean;
  keepDataDir?: boolean;
}

export interface RpcAuth {
  user: string;
  pass: string;
}

export interface BitcoindUtxo {
  txid: string;
  vout: number;
  /** BTC as reported by bitcoind. */
  amount: number;
  scriptPubKey: string;
  height?: number;
}

export interface Bitcoind {
  readonly pid: number | undefined;
  readonly datadir: string;
  readonly rpcPort: number;
  readonly p2pPort: number;
  readonly zmqBlockPort: number;
  readonly zmqTxPort: number;
  readonly zmqPubRawBlock: string;
  readonly zmqPubRawTx: string;
  readonly rpcUrl: string;
  readonly cookiePath: string;
  readonly walletName: string;
  /** Cookie user/pass as bitcoind wrote them. Re-read per call; the file can change on restart. */
  auth(): RpcAuth;
  /** JSON-RPC call against the node (wallet methods route to the single loaded wallet). */
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Same, but explicitly against the miner wallet endpoint. */
  walletRpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Mine n blocks to the miner wallet; returns block hashes. */
  mine(n: number): Promise<string[]>;
  /** Send BTC from the miner wallet; returns txid. */
  sendTo(addr: string, btc: number | string): Promise<string>;
  /** Fresh miner-wallet address (bech32 by default). */
  newAddress(type?: "bech32" | "bech32m" | "p2sh-segwit" | "legacy"): Promise<string>;
  blockHeight(): Promise<number>;
  /** Confirmed miner-wallet balance in sats. */
  balanceSats(): Promise<number>;
  /** UTXO-set scan for a list of addresses; does not need a wallet. */
  scanAddresses(addresses: string[]): Promise<{ utxos: BitcoindUtxo[]; totalSats: number }>;
  /** Raw tx lookup via txindex. */
  getRawTransaction(txid: string): Promise<Record<string, unknown>>;
  /** bitcoin-cli argv prefix for humans (printed by e2e-up). */
  cliArgs(): string[];
  /** Clean shutdown (RPC stop, then SIGTERM fallback) and temp dir removal. */
  stop(): Promise<void>;
  /** SIGKILL, no cleanup. */
  kill(): Promise<void>;
}

export async function startBitcoind(opts: BitcoindOpts = {}): Promise<Bitcoind> {
  const bin = opts.bin ?? process.env["BITCOIND_BIN"] ?? "bitcoind";
  const cliBin = opts.cliBin ?? process.env["BITCOIN_CLI_BIN"] ?? "bitcoin-cli";
  const walletName = opts.walletName ?? "miner";
  const datadir = makeTempDir("lnd-sweeper-bitcoind");
  const [rpcPort, p2pPort, zmqBlockPort, zmqTxPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const zmqPubRawBlock = `tcp://127.0.0.1:${zmqBlockPort}`;
  const zmqPubRawTx = `tcp://127.0.0.1:${zmqTxPort}`;
  const cookiePath = join(datadir, "regtest", ".cookie");
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;

  const args = [
    "-regtest",
    `-datadir=${datadir}`,
    "-server=1",
    "-listen=1",
    "-bind=127.0.0.1",
    `-port=${p2pPort}`,
    `-rpcport=${rpcPort}`,
    "-rpcbind=127.0.0.1",
    "-rpcallowip=127.0.0.1",
    "-txindex=1",
    "-fallbackfee=0.0001",
    "-mintxfee=0.00001",
    "-blockmintxfee=0.00001",
    `-zmqpubrawblock=${zmqPubRawBlock}`,
    `-zmqpubrawtx=${zmqPubRawTx}`,
    "-printtoconsole=1",
    "-debuglogfile=0",
    "-dnsseed=0",
    "-discover=0",
    // lnd 0.18's rpcclient still expects getnetworkinfo.warnings as a string (Core >= 28 returns an array).
    "-deprecatedrpc=warnings",
  ];
  const managed: Managed = spawnDaemon(bin, args, { echo: opts.echo ?? false });

  const auth = (): RpcAuth => {
    const [user = "", pass = ""] = readFileSync(cookiePath, "utf8").trim().split(":", 2);
    return { user, pass };
  };

  const call = async <T,>(path: string, method: string, params: unknown[]): Promise<T> => {
    const { user, pass } = auth();
    const res = await fetch(`${rpcUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: "e2e", method, params }),
    });
    const text = await res.text();
    let body: { result?: T; error?: { code: number; message: string } | null };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`bitcoind ${method}: HTTP ${res.status} non-JSON reply: ${text.slice(0, 200)}`);
    }
    if (body.error) throw new Error(`bitcoind ${method}: ${body.error.message} (code ${body.error.code})`);
    return body.result as T;
  };
  const rpc = <T,>(method: string, params: unknown[] = []): Promise<T> => call<T>("/", method, params);
  const walletRpc = <T,>(method: string, params: unknown[] = []): Promise<T> =>
    call<T>(`/wallet/${walletName}`, method, params);

  const fail = (msg: string): Error => new FatalError(`${msg}\n--- bitcoind output ---\n${managed.log()}`);

  // Wait for the cookie and for RPC to answer.
  await waitFor(
    "bitcoind RPC",
    async () => {
      if (managed.exited()) throw fail("bitcoind exited during startup");
      if (!existsSync(cookiePath)) return undefined;
      const info = await rpc<{ blocks: number }>("getblockchaininfo");
      return info;
    },
    { timeoutMs: 60_000 },
  ).catch((e: unknown) => {
    if (e instanceof FatalError) throw e;
    throw fail(e instanceof Error ? e.message : String(e));
  });

  // Descriptor wallet for mining and funding.
  const wallets = await rpc<string[]>("listwallets");
  if (!wallets.includes(walletName)) {
    await rpc("createwallet", [walletName, false, false, "", false, true, true]);
  }

  const newAddress = (type: "bech32" | "bech32m" | "p2sh-segwit" | "legacy" = "bech32"): Promise<string> =>
    walletRpc<string>("getnewaddress", ["", type]);

  const node: Bitcoind = {
    pid: managed.proc.pid,
    datadir,
    rpcPort,
    p2pPort,
    zmqBlockPort,
    zmqTxPort,
    zmqPubRawBlock,
    zmqPubRawTx,
    rpcUrl,
    cookiePath,
    walletName,
    auth,
    rpc,
    walletRpc,
    newAddress,
    async mine(n) {
      const addr = await newAddress();
      return walletRpc<string[]>("generatetoaddress", [n, addr]);
    },
    async sendTo(addr, btc) {
      const amount = typeof btc === "number" ? Number(btc.toFixed(8)) : Number(btc);
      return walletRpc<string>("sendtoaddress", [addr, amount]);
    },
    blockHeight: () => rpc<number>("getblockcount"),
    async balanceSats() {
      return btcToSats(await walletRpc<number>("getbalance"));
    },
    async scanAddresses(addresses) {
      const descs = addresses.map((a) => `addr(${a})`);
      const r = await rpc<{
        success: boolean;
        unspents: { txid: string; vout: number; amount: number; scriptPubKey: string; height: number }[];
        total_amount: number;
      }>("scantxoutset", ["start", descs]);
      if (!r.success) throw new Error("scantxoutset did not succeed");
      return {
        utxos: r.unspents.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          amount: u.amount,
          scriptPubKey: u.scriptPubKey,
          height: u.height,
        })),
        totalSats: btcToSats(r.total_amount),
      };
    },
    getRawTransaction: (txid) => rpc<Record<string, unknown>>("getrawtransaction", [txid, true]),
    cliArgs: () => [cliBin, "-regtest", `-datadir=${datadir}`, `-rpcport=${rpcPort}`, `-rpcwallet=${walletName}`],
    async stop() {
      try {
        if (!managed.exited()) await rpc("stop");
      } catch {
        /* fall through to signal */
      }
      await stopProcess(managed.proc, 20_000);
      if (!opts.keepDataDir) removeDir(datadir);
    },
    kill: () => killHard(managed.proc),
  };
  return node;
}
