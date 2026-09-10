/**
 * Manual UI testing stack: bitcoind + lnd + Esplora shim on regtest, with the
 * same funding scenario the e2e test uses. Run via scripts/e2e-up.sh; stop
 * with scripts/e2e-down.sh or Ctrl-C.
 *
 * Environment:
 *   E2E_MNEMONIC   24 words to restore into lnd instead of a fresh seed
 *   E2E_PASSPHRASE aezeed passphrase for that mnemonic
 *   E2E_KILL_LND=1 kill lnd and wipe its data dir after funding (true dead-node recovery)
 *   E2E_STATE_DIR  where to write state.json (default .e2e-data)
 */
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { startBitcoind, type Bitcoind } from "./bitcoind";
import { lncliBinPath, startLnd, type Lnd } from "./lnd";
import { runScenario } from "./scenario";
import { sleep } from "./util";
import { start as startShim, type Shim } from "../esplora-shim";

/** Fee rate the shim is pinned to on regtest (bitcoind's own estimate there is absent or arbitrary). */
export const SHIM_FEE_RATE = 3.5;

export interface UpState {
  startedAt: string;
  pid: number;
  bitcoind: { pid: number | undefined; datadir: string; rpcPort: number; cliArgs: string[] };
  lnd: { pid: number | undefined; lnddir: string; restUrl: string; rpcHost: string; alive: boolean };
  shim: { url: string; port: number };
  mnemonic: string[];
  passphrase: string | undefined;
  lndConfirmedSats: number;
  stopFile: string;
}

export async function main(): Promise<void> {
  const stateDir = resolve(process.env["E2E_STATE_DIR"] ?? ".e2e-data");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "state.json");
  const stopFile = join(stateDir, "stop");
  if (existsSync(stopFile)) unlinkSync(stopFile);

  let bd: Bitcoind | undefined;
  let lnd: Lnd | undefined;
  let shim: Shim | undefined;
  let lndAlive = false;

  const shutdown = async (): Promise<void> => {
    process.stderr.write("\n[e2e-up] shutting down\n");
    if (lnd && lndAlive) {
      await lnd.stop().catch(() => lnd!.kill());
      lnd.deleteDataDir();
    }
    if (shim) await shim.stop().catch(() => undefined);
    if (bd) await bd.stop().catch(() => undefined);
    for (const f of [stateFile, stopFile]) if (existsSync(f)) unlinkSync(f);
  };

  try {
    process.stderr.write("[e2e-up] starting bitcoind\n");
    bd = await startBitcoind();
    await bd.mine(110);

    const words = process.env["E2E_MNEMONIC"]?.trim().split(/\s+/);
    const passphrase = process.env["E2E_PASSPHRASE"] || undefined;
    process.stderr.write(`[e2e-up] starting lnd (${words ? "restoring supplied seed" : "fresh seed"})\n`);
    lnd = await startLnd({
      bitcoind: bd,
      ...(words ? { mnemonic: words, recoveryWindow: 250 } : {}),
      ...(passphrase ? { aezeedPassphrase: passphrase } : {}),
    });
    lndAlive = true;
    await lnd.waitSynced();

    process.stderr.write("[e2e-up] funding lnd on all three address kinds and spending for change\n");
    const scenario = await runScenario(bd, lnd);

    process.stderr.write("[e2e-up] starting esplora shim\n");
    shim = await startShim({ rpcUrl: bd.rpcUrl, cookiePath: bd.cookiePath, host: "127.0.0.1", feeRateSatPerVb: SHIM_FEE_RATE });

    if (process.env["E2E_KILL_LND"] === "1") {
      await lnd.kill();
      lnd.deleteDataDir();
      lndAlive = false;
    }

    const state: UpState = {
      startedAt: new Date().toISOString(),
      pid: process.pid,
      bitcoind: { pid: bd.pid, datadir: bd.datadir, rpcPort: bd.rpcPort, cliArgs: bd.cliArgs() },
      lnd: { pid: lnd.pid, lnddir: lnd.lnddir, restUrl: lnd.restUrl, rpcHost: lnd.rpcHost, alive: lndAlive },
      shim: { url: shim.baseUrl, port: shim.port },
      mnemonic: lnd.mnemonic,
      passphrase: lnd.aezeedPassphrase,
      lndConfirmedSats: scenario.lndConfirmedSats,
      stopFile,
    };
    writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const lines = [
      "",
      "lnd-sweeper e2e stack is up (regtest)",
      "",
      `  seed words     ${lnd.mnemonic.join(" ")}`,
      `  passphrase     ${lnd.aezeedPassphrase ?? "(none)"}`,
      `  esplora url    ${shim.baseUrl} (fee estimate ${SHIM_FEE_RATE} sat/vB)`,
      `  lnd balance    ${scenario.lndConfirmedSats} sats in ${scenario.lndUtxos.length} utxos${lndAlive ? "" : " (lnd killed and wiped)"}`,
      `  change addrs   ${scenario.changeAddresses.join(", ")}`,
      `  bitcoin-cli    ${bd.cliArgs().join(" ")}`,
      lndAlive ? `  lncli          ${lncliBinPath()} --network=regtest --lnddir=${lnd.lnddir} --rpcserver=${lnd.rpcHost}` : "",
      `  state          ${stateFile}`,
      "",
      "  Paste the words and the esplora url into the UI. Stop with scripts/e2e-down.sh or Ctrl-C.",
      "",
    ];
    process.stdout.write(lines.filter((l) => l !== "").join("\n") + "\n");

    let stopping = false;
    const onSignal = (): void => {
      stopping = true;
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    while (!stopping && !existsSync(stopFile)) await sleep(500);
  } finally {
    await shutdown();
  }
}
