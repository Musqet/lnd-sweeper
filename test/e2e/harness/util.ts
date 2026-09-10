/**
 * Small shared helpers for the e2e harness: free ports, polling, process control.
 * Test-only code; never shipped in the HTML bundle.
 */
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ask the kernel for a free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Thrown inside a waitFor() poll to abort immediately instead of retrying (e.g. the daemon died). */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

/** Poll `fn` until it returns a non-undefined value or the deadline passes. */
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined> | T | undefined,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      if (e instanceof FatalError) throw e;
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  const why = lastErr instanceof Error ? `: last error: ${lastErr.message}` : "";
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${why}`);
}

/** Make a temp dir under the OS temp root (or E2E_TMP_ROOT if set). */
export function makeTempDir(prefix: string): string {
  const root = process.env["E2E_TMP_ROOT"] ?? tmpdir();
  return mkdtempSync(join(root, `${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export interface Managed {
  proc: ChildProcess;
  /** Rolling tail of stdout+stderr, for error messages. */
  log: () => string;
  exited: () => boolean;
}

/** Spawn a daemon and keep a bounded tail of its output for diagnostics. */
export function spawnDaemon(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; echo?: boolean } = {},
): Managed {
  const proc = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  let size = 0;
  const push = (b: Buffer): void => {
    const s = b.toString();
    if (opts.echo) process.stderr.write(s);
    chunks.push(s);
    size += s.length;
    while (size > 64_000 && chunks.length > 1) size -= chunks.shift()!.length;
  };
  proc.stdout?.on("data", push);
  proc.stderr?.on("data", push);
  let done = false;
  proc.on("exit", () => {
    done = true;
  });
  proc.on("error", (e) => push(Buffer.from(`spawn error: ${e.message}\n`)));
  return { proc, log: () => chunks.join(""), exited: () => done };
}

/** Send a signal and wait for exit, escalating to SIGKILL after `graceMs`. */
export async function stopProcess(proc: ChildProcess, graceMs = 15_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM");
  const t = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, graceMs);
  await exited;
  clearTimeout(t);
}

/** Hard kill, no cleanup. Simulates a dead box. */
export function killHard(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill("SIGKILL");
  return exited;
}

export const btcToSats = (btc: number | string): number => Math.round(Number(btc) * 1e8);
export const satsToBtc = (sats: number): string => (sats / 1e8).toFixed(8);
