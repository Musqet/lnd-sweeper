import { describe, expect, it } from "vitest";
import {
  type ClientStatus,
  EsploraError,
  PUBLIC_SERVERS,
  RotatingChainClient,
  publicServerUrls,
  serverLabel,
} from "../../src/chain";
import type { Network } from "../../src/types";

/** Route reply for a path, relative to a backend's ".../api/". */
type Reply = { status?: number; body?: string; headers?: Record<string, string> };
type Behaviour = Reply | Reply[] | (() => Response | Promise<Response>);
type HostRoutes = Record<string, Behaviour>;

/** fetch double dispatching by host, then by path after "/api/". Records every call. */
function multiFetch(hosts: Record<string, HostRoutes>) {
  const calls: { host: string; path: string; method: string }[] = [];
  const counters = new Map<string, number>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(urlStr);
    const path = u.pathname.split("/api/")[1] ?? "";
    calls.push({ host: u.host, path, method: init?.method ?? "GET" });
    const routes = hosts[u.host];
    if (!routes) return new Response("no such host", { status: 502 });
    let route = routes[path];
    if (route === undefined) return new Response("Not found", { status: 404 });
    if (Array.isArray(route)) {
      const key = `${u.host}/${path}`;
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      route = route[Math.min(n, route.length - 1)]!;
    }
    if (typeof route === "function") return route();
    return new Response(route.body ?? "", { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetchImpl, calls };
}

const A = "https://a.example/api";
const B = "https://b.example/api";
const C = "https://c.example/api";

function makeRotating(urls: string[], hosts: Record<string, HostRoutes>, extra: Record<string, unknown> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const statuses: ClientStatus[] = [];
  const { fetchImpl, calls } = multiFetch(hosts);
  const client = new RotatingChainClient(urls, {
    network: "mainnet" as Network,
    fetch: fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    onStatus: (s) => statuses.push(s),
    backend: { ratePerSecond: 1e6, concurrency: 8, backoffBaseMs: 100, backoffMaxMs: 100 },
    ...extra,
  });
  return { client, sleeps, statuses, calls, advance: (ms: number) => (t += ms), now: () => t };
}

const tip = (h: string): Response => new Response(h, { status: 200 });

describe("server registry", () => {
  it("lists trusted Esplora URLs per network, all https with an /api path", () => {
    for (const net of ["mainnet", "signet", "testnet", "regtest"] as Network[]) {
      for (const s of PUBLIC_SERVERS[net]) {
        expect(s.url).toMatch(/^https:\/\/.+\/api$/);
        expect(s.name.length).toBeGreaterThan(0);
      }
    }
    expect(publicServerUrls("mainnet").length).toBeGreaterThanOrEqual(2);
    // regtest is local-only.
    expect(publicServerUrls("regtest")).toEqual([]);
    // Blockstream serves testnet3, not the testnet4 we default to, so it is excluded.
    expect(publicServerUrls("testnet").every((u) => u.includes("mempool.space"))).toBe(true);
  });

  it("serverLabel is the host", () => {
    expect(serverLabel("https://mempool.space/signet/api")).toBe("mempool.space");
  });
});

describe("RotatingChainClient", () => {
  it("needs at least one server", () => {
    expect(() => new RotatingChainClient([], { network: "mainnet" })).toThrow(/at least one/);
  });

  it("serves from the first backend and never touches the others when it is healthy", async () => {
    const { client, calls, statuses } = makeRotating([A, B], {
      "a.example": { "blocks/tip/height": { body: "800000" } },
      "b.example": { "blocks/tip/height": { body: "999999" } },
    });
    expect(await client.getTipHeight()).toBe(800000);
    expect(await client.getTipHeight()).toBe(800000);
    expect(calls.every((c) => c.host === "a.example")).toBe(true);
    expect(statuses.filter((s) => s.kind === "switch")).toEqual([]);
  });

  it("rotates to the next backend the instant the first returns 429, with no wait", async () => {
    const { client, sleeps, statuses, calls } = makeRotating([A, B], {
      "a.example": { "blocks/tip/height": { status: 429, body: "slow down" } },
      "b.example": { "blocks/tip/height": { body: "800001" } },
    });
    expect(await client.getTipHeight()).toBe(800001);
    expect(sleeps).toEqual([]); // no waiting: we rotated
    expect(calls.map((c) => c.host)).toEqual(["a.example", "b.example"]);
    const sw = statuses.filter((s): s is Extract<ClientStatus, { kind: "switch" }> => s.kind === "switch");
    expect(sw).toHaveLength(1);
    expect(sw[0]).toMatchObject({ server: "b.example", reason: "rate-limited", allCooling: false });
  });

  it("returns home to the preferred backend once its cooldown expires", async () => {
    const { client, statuses, calls, advance } = makeRotating([A, B], {
      "a.example": { "blocks/tip/height": [{ status: 429 }, { body: "111" }] },
      "b.example": { "blocks/tip/height": { body: "222" } },
    });
    expect(await client.getTipHeight()).toBe(222); // A 429 -> B
    advance(31_000); // past A's default 30 s cooldown
    expect(await client.getTipHeight()).toBe(111); // back on A
    const hosts = calls.map((c) => c.host);
    expect(hosts).toEqual(["a.example", "b.example", "a.example"]);
    const switches = statuses.filter((s) => s.kind === "switch").map((s) => (s as { server: string }).server);
    expect(switches).toEqual(["b.example", "a.example"]);
  });

  it("honours Retry-After for the cooldown length", async () => {
    // Single backend: 429 with Retry-After 5, then success. It must wait exactly 5 s.
    const { client, sleeps } = makeRotating([A], {
      "a.example": { "blocks/tip/height": [{ status: 429, headers: { "retry-after": "5" } }, { body: "5" }] },
    });
    expect(await client.getTipHeight()).toBe(5);
    expect(sleeps).toEqual([5000]);
  });

  it("rotates on a network/5xx error using the error cooldown", async () => {
    const { client, statuses, calls } = makeRotating([A, B], {
      "a.example": {
        "blocks/tip/height": () => {
          throw new TypeError("network down");
        },
      },
      "b.example": { "blocks/tip/height": { body: "42" } },
    });
    expect(await client.getTipHeight()).toBe(42);
    expect(calls.some((c) => c.host === "b.example")).toBe(true);
    const sw = statuses.find((s) => s.kind === "switch") as { reason: string } | undefined;
    expect(sw?.reason).toBe("error");
  });

  it("waits for the soonest backend when every one is cooling", async () => {
    const { client, sleeps, statuses } = makeRotating([A, B], {
      "a.example": { "blocks/tip/height": [{ status: 429 }, { body: "1" }] },
      "b.example": { "blocks/tip/height": [{ status: 429 }, { body: "2" }] },
    });
    expect(await client.getTipHeight()).toBe(1);
    // Both cooled 30 s at the same instant; we waited once for that.
    expect(sleeps).toEqual([30_000]);
    expect(statuses.some((s) => s.kind === "switch" && (s as { allCooling: boolean }).allCooling)).toBe(true);
  });

  it("announces recovery after an all-cooling wait so the UI can clear the slow-down note", async () => {
    // Both 429 once, then both fine. We must see an allCooling:true switch, then a
    // later allCooling:false switch when a server recovers (that clears throttled).
    const { client, statuses } = makeRotating([A, B], {
      "a.example": { "blocks/tip/height": [{ status: 429 }, { body: "1" }] },
      "b.example": { "blocks/tip/height": [{ status: 429 }, { body: "2" }] },
    });
    expect(await client.getTipHeight()).toBe(1);
    const switches = statuses.filter((s): s is Extract<ClientStatus, { kind: "switch" }> => s.kind === "switch");
    const cooling = switches.findIndex((s) => s.allCooling);
    expect(cooling).toBeGreaterThanOrEqual(0);
    // A later switch reports a healthy server (allCooling:false), which the adapter maps to throttled:false.
    expect(switches.slice(cooling + 1).some((s) => !s.allCooling)).toBe(true);
  });

  it("does not announce a switch on the very first request", async () => {
    const { client, statuses } = makeRotating([A, B], {
      "a.example": { "blocks/tip/height": { body: "7" } },
      "b.example": { "blocks/tip/height": { body: "8" } },
    });
    await client.getTipHeight();
    expect(statuses.filter((s) => s.kind === "switch")).toEqual([]);
  });

  it("gives up after a continuous deadline with no progress anywhere", async () => {
    const { client } = makeRotating(
      [A, B],
      {
        "a.example": { "blocks/tip/height": { status: 429 } },
        "b.example": { "blocks/tip/height": { status: 429 } },
      },
      { deadlineMs: 60_000, rateLimitCooldownMs: 30_000 },
    );
    const err = await client.getTipHeight().catch((e) => e);
    expect(err).toBeInstanceOf(EsploraError);
    // The give-up is a HARD stop: its text must not read as a transient rate limit,
    // or the scan UI would auto-retry it forever (it matches /429|rate.?limit/i).
    expect(String(err.message)).not.toMatch(/429|rate.?limit|too many requests/i);
    expect((err as EsploraError).status).toBeUndefined();
  });

  it("does not give up on a brief blip long after an earlier success (no stale deadline)", async () => {
    // Reproduces the cached-client resume bug: succeed, idle far past the deadline,
    // then both backends 429 once. It must wait the cooldown and recover, not give up.
    const { client, advance } = makeRotating(
      [A, B],
      {
        // A serves the first request; on resume both 429 once (all cooling), then A recovers.
        "a.example": { "blocks/tip/height": [{ body: "100" }, { status: 429 }, { body: "101" }] },
        "b.example": { "blocks/tip/height": [{ status: 429 }, { body: "201" }] },
      },
      { deadlineMs: 60_000, rateLimitCooldownMs: 30_000 },
    );
    expect(await client.getTipHeight()).toBe(100); // first success
    advance(10 * 60_000); // idle 10 min, well past the 60 s deadline
    // Now a resumed lookup: A 429, B 429, all cooling, wait 30 s, A recovers.
    expect(await client.getTipHeight()).toBe(101);
  });

  it("propagates an abort", async () => {
    const ac = new AbortController();
    ac.abort();
    const { client } = makeRotating([A, B], { "a.example": {}, "b.example": {} }, { signal: ac.signal });
    await expect(client.getTipHeight()).rejects.toBeTruthy();
  });

  it("carries results through correctly across a rotation (no cross-wiring)", async () => {
    const utxo = JSON.stringify([{ txid: "aa".repeat(32), vout: 0, value: 1234, status: { confirmed: true, block_height: 1, block_hash: "x", block_time: 1 } }]);
    const { client } = makeRotating([A, B], {
      "a.example": { [`address/bc1qxyz/utxo`]: { status: 429 } },
      "b.example": { [`address/bc1qxyz/utxo`]: { body: utxo } },
    });
    const got = await client.getAddressUtxos("bc1qxyz");
    expect(got).toHaveLength(1);
    expect(got[0]!.value).toBe(1234);
  });
});

describe("RotatingChainClient.broadcast", () => {
  const HEX = "aa".repeat(32); // not a real tx; used only to key the POST route
  const TXID = "bb".repeat(32);

  it("returns the first backend that accepts and does not hit the rest", async () => {
    const { client, calls } = makeRotating([A, B], {
      "a.example": { tx: { body: TXID } },
      "b.example": { tx: { body: "unused" } },
    });
    expect(await client.broadcast(HEX)).toBe(TXID);
    expect(calls.every((c) => c.host === "a.example")).toBe(true);
  });

  it("moves past a failing backend to one that accepts", async () => {
    const { client, calls } = makeRotating([A, B], {
      "a.example": { tx: { status: 400, body: "sendrawtransaction RPC error" } },
      "b.example": { tx: { body: TXID } },
    });
    expect(await client.broadcast(HEX)).toBe(TXID);
    expect(calls.some((c) => c.host === "b.example")).toBe(true);
  });

  it("throws the first rejection when every backend refuses", async () => {
    const { client } = makeRotating([A, B], {
      "a.example": { tx: { status: 400, body: "bad-txns-inputs-missingorspent" } },
      "b.example": { tx: { status: 400, body: "also refused" } },
    });
    await expect(client.broadcast(HEX)).rejects.toBeInstanceOf(EsploraError);
  });

  it("prefers a definitive rejection over a transient one (rate limit hides nothing)", async () => {
    // A is merely rate-limited; B gives the real reason. The user must see B's reason.
    const { client } = makeRotating([A, B], {
      "a.example": { tx: { status: 429, body: "slow down" } },
      "b.example": { tx: { status: 400, body: "bad-txns-inputs-missingorspent" } },
    });
    const err = await client.broadcast(HEX).catch((e) => e);
    expect(err).toBeInstanceOf(EsploraError);
    expect(String(err.message)).toContain("bad-txns-inputs-missingorspent");
  });
});
