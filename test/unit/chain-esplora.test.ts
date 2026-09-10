import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHAIN_PAGE_SIZE,
  DEFAULT_RATE_LIMIT_DEADLINE_MS,
  DEFAULT_RATE_PER_SECOND,
  EsploraClient,
  EsploraError,
  EsploraUrlError,
  Limiter,
  RateLimiter,
  SLOW_DOWN_MS,
  normaliseBaseUrl,
  toAddressTx,
  txidOf,
  type ClientStatus,
  type RawTx,
} from "../../src/chain";

const FIX = new URL("./chain-fixtures/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIX), "utf8");
const fixtureJson = <T,>(name: string): T => JSON.parse(fixture(name)) as T;

const BASE = "https://mempool.space/signet/api";
const USED = "tb1qcvghydtuhcn8ehxxfl926ldcwhjegls5zvw9v2";
const UNUSED = "tb1qcd2fwxufkdwzqxa5hr40kc8ev7uq59gtzz6yah";
const WITH_MEMPOOL = "tb1q2fwm9cxug27cq4uslaeepwcux6trj8pt266mwz";
const BUSY = "tb1qr6lmcexy6285f3a04j2a75d39qvcdek739g8cz";

type Route = { status?: number; body?: string; headers?: Record<string, string> } | ((init: RequestInit) => Response | Promise<Response>);

/** fetch double keyed by path (relative to BASE). Records every call. */
function mockFetch(routes: Record<string, Route | Route[]>) {
  const calls: { path: string; method: string; body?: string }[] = [];
  const counters = new Map<string, number>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.slice(BASE.length + 1);
    const call: { path: string; method: string; body?: string } = { path, method: init?.method ?? "GET" };
    if (typeof init?.body === "string") call.body = init.body;
    calls.push(call);
    let route = routes[path];
    if (route === undefined) return new Response("Not found", { status: 404 });
    if (Array.isArray(route)) {
      const n = counters.get(path) ?? 0;
      counters.set(path, n + 1);
      route = route[Math.min(n, route.length - 1)]!;
    }
    if (typeof route === "function") return route(init ?? {});
    return new Response(route.body ?? "", { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof EsploraClient>[1]> = {}) {
  const sleeps: number[] = [];
  const client = new EsploraClient(BASE, {
    network: "signet",
    fetch: fetchImpl,
    ratePerSecond: 1e6, // pacing is exercised explicitly in the "pacing" suite below
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, sleeps };
}

/** Client with a fake clock: sleeping advances time, so pacing and deadlines are deterministic. */
function makePacedClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof EsploraClient>[1]> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const statuses: ClientStatus[] = [];
  const client = new EsploraClient(BASE, {
    network: "signet",
    fetch: fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { client, sleeps, statuses, now: () => t, advance: (ms: number) => (t += ms) };
}

describe("normaliseBaseUrl", () => {
  it("adds https, strips query/hash and guarantees one trailing slash", () => {
    expect(normaliseBaseUrl("mempool.space/api")).toBe("https://mempool.space/api/");
    expect(normaliseBaseUrl("https://mempool.space/signet/api/")).toBe("https://mempool.space/signet/api/");
    expect(normaliseBaseUrl("https://mempool.space/signet/api///")).toBe("https://mempool.space/signet/api/");
    expect(normaliseBaseUrl("  http://127.0.0.1:3002?x=1#y ")).toBe("http://127.0.0.1:3002/");
    expect(normaliseBaseUrl("http://localhost:3000/esplora")).toBe("http://localhost:3000/esplora/");
  });
  it("rejects non-http schemes and garbage", () => {
    expect(() => normaliseBaseUrl("ftp://x")).toThrow(/http or https/);
    expect(() => normaliseBaseUrl("")).toThrow(/empty/);
    expect(() => normaliseBaseUrl("http://")).toThrow(/not valid/);
  });
});

describe("EsploraClient against recorded mempool.space responses", () => {
  it("reads the tip height", async () => {
    const { fetchImpl } = mockFetch({ "blocks/tip/height": { body: fixture("signet-blocks-tip-height.txt") } });
    const { client } = makeClient(fetchImpl);
    expect(await client.getTipHeight()).toBe(321475);
  });

  it("maps address stats (used, unused, mempool activity)", async () => {
    const { fetchImpl } = mockFetch({
      [`address/${USED}`]: { body: fixture("signet-address-stats-used.json") },
      [`address/${UNUSED}`]: { body: fixture("signet-address-stats-unused.json") },
      [`address/${WITH_MEMPOOL}`]: { body: fixture("signet-address-stats-with-mempool.json") },
    });
    const { client } = makeClient(fetchImpl);
    expect(await client.getAddressStats(USED)).toEqual({
      chainTxCount: 9,
      mempoolTxCount: 0,
      fundedSats: 7039689300,
      spentSats: 6059767475,
    });
    expect(await client.getAddressStats(UNUSED)).toEqual({ chainTxCount: 0, mempoolTxCount: 0, fundedSats: 0, spentSats: 0 });
    const m = await client.getAddressStats(WITH_MEMPOOL);
    expect(m.chainTxCount).toBe(1);
    expect(m.mempoolTxCount).toBe(1);
    expect(m.spentSats).toBe(188774847556);
  });

  it("maps utxos and keeps the status shape", async () => {
    const { fetchImpl } = mockFetch({
      [`address/${USED}/utxo`]: { body: fixture("signet-address-utxo-used.json") },
      [`address/${UNUSED}/utxo`]: { body: fixture("signet-address-utxo-unused.json") },
    });
    const { client } = makeClient(fetchImpl);
    expect(await client.getAddressUtxos(USED)).toEqual([
      {
        txid: "7005f70d3ac295fbf5dbaec8ae8f72f33564c543a1a7edd0f609468c82c84260",
        vout: 1,
        value: 979921825,
        status: { confirmed: true, blockHeight: 321475, blockTime: 1789034121 },
      },
    ]);
    expect(await client.getAddressUtxos(UNUSED)).toEqual([]);
  });

  it("flags unconfirmed utxos without block fields", async () => {
    const { fetchImpl } = mockFetch({
      "address/x/utxo": { body: JSON.stringify([{ txid: "ab".repeat(32), vout: 0, value: 5, status: { confirmed: false } }]) },
    });
    const { client } = makeClient(fetchImpl);
    expect(await client.getAddressUtxos("x")).toEqual([{ txid: "ab".repeat(32), vout: 0, value: 5, status: { confirmed: false } }]);
  });

  it("converts a tx, including mempool status, prevout address and value", async () => {
    const raw = fixtureJson<RawTx[]>("signet-address-txs-with-mempool.json");
    const [unconfirmed, confirmed] = raw.map(toAddressTx);
    expect(unconfirmed!.status).toEqual({ confirmed: false });
    expect(confirmed!.status).toEqual({ confirmed: true, blockHeight: 321475, blockTime: 1789034121 });
    expect(unconfirmed!.vin.some((v) => v.address === WITH_MEMPOOL && v.value === 188774847556)).toBe(true);
    expect(confirmed!.vout.some((o) => o.address === WITH_MEMPOOL && o.value === 188774847556)).toBe(true);
    for (const o of confirmed!.vout) expect(o.scriptPubKey).toMatch(/^[0-9a-f]+$/);
  });

  it("pages through /txs then /txs/chain/:last_seen_txid until a short page (mempool.space: 50 then 25)", async () => {
    const page1 = fixtureJson<RawTx[]>("signet-address-txs-page1.json");
    const page2 = fixtureJson<RawTx[]>("signet-address-txs-chain-cursor.json");
    expect(page1).toHaveLength(50);
    expect(page2).toHaveLength(CHAIN_PAGE_SIZE);
    const last1 = page1[page1.length - 1]!.txid;
    const last2 = page2[page2.length - 1]!.txid;
    const { fetchImpl, calls } = mockFetch({
      [`address/${BUSY}/txs`]: { body: JSON.stringify(page1) },
      [`address/${BUSY}/txs/chain/${last1}`]: { body: JSON.stringify(page2) },
      [`address/${BUSY}/txs/chain/${last2}`]: { body: "[]" },
    });
    const { client } = makeClient(fetchImpl);
    const txs = await client.getAddressTxs(BUSY);
    expect(txs).toHaveLength(75);
    expect(new Set(txs.map((t) => t.txid)).size).toBe(75);
    expect(calls.map((c) => c.path)).toEqual([
      `address/${BUSY}/txs`,
      `address/${BUSY}/txs/chain/${last1}`,
      `address/${BUSY}/txs/chain/${last2}`,
    ]);
  });

  it("stops after the first page when it holds fewer than 25 confirmed txs (plain Esplora)", async () => {
    const page = fixtureJson<RawTx[]>("signet-address-txs-chain-cursor.json").slice(0, 10);
    const { fetchImpl, calls } = mockFetch({ "address/a/txs": { body: JSON.stringify(page) } });
    const { client } = makeClient(fetchImpl);
    expect(await client.getAddressTxs("a")).toHaveLength(10);
    expect(calls).toHaveLength(1);
  });

  it("does not count mempool txs towards the page size and de-duplicates across pages", async () => {
    const chain = fixtureJson<RawTx[]>("signet-address-txs-chain-cursor.json");
    const mem = fixtureJson<RawTx[]>("signet-address-txs-with-mempool.json")[0]!; // unconfirmed
    const last = chain[chain.length - 1]!.txid;
    const { fetchImpl, calls } = mockFetch({
      "address/a/txs": { body: JSON.stringify([mem, ...chain]) },
      // Backend ignores the cursor and repeats itself: must terminate.
      [`address/a/txs/chain/${last}`]: { body: JSON.stringify(chain) },
    });
    const { client } = makeClient(fetchImpl);
    const txs = await client.getAddressTxs("a");
    expect(txs).toHaveLength(26);
    expect(txs[0]!.status.confirmed).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("maps mempool.space recommended fees onto confirmation targets", async () => {
    const { fetchImpl } = mockFetch({ "v1/fees/recommended": { body: fixture("signet-v1-fees-recommended.json") } });
    const { client } = makeClient(fetchImpl);
    expect(await client.getFeeEstimates()).toEqual({ "1": 1, "3": 1, "6": 1, "144": 1, "1008": 1 });
    const { fetchImpl: f2 } = mockFetch({
      "v1/fees/recommended": { body: JSON.stringify({ fastestFee: 12, halfHourFee: 9, hourFee: 5, economyFee: 2, minimumFee: 1 }) },
    });
    expect(await makeClient(f2).client.getFeeEstimates()).toEqual({ "1": 12, "3": 9, "6": 5, "144": 2, "1008": 1 });
  });

  it("falls back to /fee-estimates on plain Esplora (404 on the mempool.space endpoint)", async () => {
    const { fetchImpl, calls } = mockFetch({
      "v1/fees/recommended": { status: 404, body: "" },
      "fee-estimates": { body: fixture("blockstream-testnet-fee-estimates.json") },
    });
    const { client } = makeClient(fetchImpl);
    const fees = await client.getFeeEstimates();
    expect(fees["1"]).toBe(1.01);
    expect(fees["144"]).toBeCloseTo(0.675);
    expect(Object.keys(fees)).toHaveLength(28);
    expect(calls.map((c) => c.path)).toEqual(["v1/fees/recommended", "fee-estimates"]);
  });

  it("accepts the deprecated 203 response mempool.space gives for /fee-estimates", async () => {
    const { fetchImpl } = mockFetch({
      "v1/fees/recommended": { status: 404, body: "" },
      "fee-estimates": { status: 203, body: fixture("signet-fee-estimates.json") },
    });
    const { client } = makeClient(fetchImpl);
    expect((await client.getFeeEstimates())["1"]).toBe(1);
  });

  it("broadcasts as text/plain and returns the txid", async () => {
    const txid = "7005f70d3ac295fbf5dbaec8ae8f72f33564c543a1a7edd0f609468c82c84260";
    const { fetchImpl, calls } = mockFetch({ tx: { body: txid } });
    const { client } = makeClient(fetchImpl);
    expect(await client.broadcast("0200deadbeef")).toBe(txid);
    expect(calls[0]).toEqual({ path: "tx", method: "POST", body: "0200deadbeef" });
  });

  it("surfaces the backend's rejection verbatim and does not retry a 400", async () => {
    const errors = fixtureJson<Record<string, { status: number; body: string }>>("error-responses.json");
    const rejection = errors["POST /tx (body: deadbeef) on mempool.space"]!;
    const { fetchImpl, calls } = mockFetch({ tx: { status: rejection.status, body: rejection.body } });
    const { client, sleeps } = makeClient(fetchImpl);
    const err = await client.broadcast("deadbeef").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsploraError);
    expect((err as EsploraError).status).toBe(400);
    expect((err as EsploraError).body).toBe(rejection.body);
    expect((err as Error).message).toContain("TX decode failed. Make sure the tx has at least one input.");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("rejects non-hex before touching the network", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const { client } = makeClient(fetchImpl);
    await expect(client.broadcast("zz")).rejects.toThrow(/not valid hex/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces 'Invalid Bitcoin address' and 'Too many unspent transaction outputs' bodies", async () => {
    const errors = fixtureJson<Record<string, { status: number; body: string }>>("error-responses.json");
    const bad = errors["GET /address/notanaddress"]!;
    const tooMany = errors["GET /address/tb1pruektj90gg8nysa7yuk07w7ucwlywrf4p02lq3sz49f05xd00djscyt2fw/utxo"]!;
    const { fetchImpl } = mockFetch({
      "address/notanaddress": { status: bad.status, body: bad.body },
      "address/big/utxo": { status: tooMany.status, body: tooMany.body },
    });
    const { client } = makeClient(fetchImpl);
    await expect(client.getAddressStats("notanaddress")).rejects.toThrow("Invalid Bitcoin address");
    await expect(client.getAddressUtxos("big")).rejects.toThrow(/Too many unspent transaction outputs/);
  });
});

describe("EsploraClient transport", () => {
  it("retries 429 (Retry-After) and 5xx (exponential backoff) with separate counters", async () => {
    const { fetchImpl, calls } = mockFetch({
      "blocks/tip/height": [
        { status: 429, body: "slow down", headers: { "retry-after": "2" } },
        { status: 503, body: "" },
        { status: 502, body: "" },
        { body: "100" },
      ],
    });
    const { client, sleeps } = makeClient(fetchImpl, { backoffBaseMs: 100, maxRetries: 2 });
    expect(await client.getTipHeight()).toBe(100);
    expect(calls).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
    expect(sleeps[0]).toBe(2000); // Retry-After: 2
    expect(sleeps[1]).toBeGreaterThanOrEqual(100); // 5xx attempt 1: 100 ms base (+ jitter), the 429 did not consume a retry
    expect(sleeps[1]).toBeLessThan(100 + 25);
    expect(sleeps[2]).toBeGreaterThanOrEqual(200);
    expect(sleeps[2]).toBeLessThan(200 + 50);
  });

  it("gives up after maxRetries and reports the status", async () => {
    const { fetchImpl, calls } = mockFetch({ "blocks/tip/height": { status: 500, body: "boom" } });
    const { client } = makeClient(fetchImpl, { maxRetries: 2 });
    const err = await client.getTipHeight().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsploraError);
    expect((err as EsploraError).status).toBe(500);
    expect((err as EsploraError).body).toBe("boom");
    expect(calls).toHaveLength(3);
  });

  it("retries network failures", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n++;
      if (n < 3) throw new TypeError("fetch failed");
      return new Response("7");
    };
    const { client, sleeps } = makeClient(fetchImpl);
    expect(await client.getTipHeight()).toBe(7);
    expect(n).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("times out a hung request and retries it", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((resolve, reject) => {
        n++;
        if (n === 2) {
          resolve(new Response("9"));
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const { client } = makeClient(fetchImpl, { timeoutMs: 20 });
    expect(await client.getTipHeight()).toBe(9);
    expect(n).toBe(2);
  });

  it("throws a TimeoutError-derived EsploraError when every attempt hangs", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const { client } = makeClient(fetchImpl, { timeoutMs: 10, maxRetries: 1 });
    const err = await client.getTipHeight().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsploraError);
    expect((err as Error).message).toMatch(/timed out/);
  });

  it("aborts in flight via the client signal, without retrying", async () => {
    const controller = new AbortController();
    let n = 0;
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        n++;
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        setTimeout(() => controller.abort(), 5);
      });
    const { client, sleeps } = makeClient(fetchImpl, { signal: controller.signal });
    const err = await client.getTipHeight().catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(n).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("refuses to start a request on an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = mockFetch({ "blocks/tip/height": { body: "1" } });
    const { client } = makeClient(fetchImpl, { signal: controller.signal });
    await expect(client.getTipHeight()).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("caps concurrent requests at the configured limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response("1");
    };
    const { client } = makeClient(fetchImpl, { concurrency: 4 });
    await Promise.all(Array.from({ length: 12 }, () => client.getTipHeight()));
    expect(peak).toBe(4);
  });

  it("Limiter runs FIFO and releases on failure", async () => {
    const l = new Limiter(1);
    const order: number[] = [];
    const first = l.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(1);
      throw new Error("x");
    });
    const second = l.run(async () => {
      order.push(2);
    });
    await expect(first).rejects.toThrow("x");
    await second;
    expect(order).toEqual([1, 2]);
    expect(l.inFlight).toBe(0);
    expect(() => new Limiter(0)).toThrow();
  });

  it("wraps non-JSON bodies in an EsploraError", async () => {
    const { fetchImpl } = mockFetch({ "address/a": { body: "<html>nope</html>" } });
    const { client } = makeClient(fetchImpl);
    await expect(client.getAddressStats("a")).rejects.toThrow(/not JSON/);
  });
});


describe("EsploraClient: critic follow-ups", () => {
  const rawTx = (txid: string, confirmed: boolean): RawTx => ({
    txid,
    fee: 1,
    vin: [],
    vout: [],
    status: confirmed ? { confirmed: true, block_height: 1, block_time: 1 } : { confirmed: false },
  });
  /** Serves mempool.space's live-observed shape: page 1 capped at 50 TOTAL with mempool txs inside the cap. */
  function mempoolSpaceLike(mem: RawTx[], conf: RawTx[], firstPageCap = 50) {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      const path = new URL(url).pathname;
      if (path.endsWith("/txs/chain")) return new Response(JSON.stringify(conf.slice(0, 25)));
      const m = /\/txs\/chain\/([0-9a-f]+)$/.exec(path);
      if (m) {
        const pos = conf.findIndex((t) => t.txid === m[1]);
        return new Response(JSON.stringify(pos === -1 ? [] : conf.slice(pos + 1, pos + 1 + 25)));
      }
      return new Response(JSON.stringify([...mem, ...conf.slice(0, Math.max(0, firstPageCap - mem.length))]));
    };
    return { fetchImpl, calls };
  }
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i.toString(16).padStart(4, "0")}`.padEnd(64, "0"));

  it("30 mempool + 100 confirmed on mempool.space: page 1 has only 20 confirmed yet paging continues to 130", async () => {
    const mem = ids("e", 30).map((t) => rawTx(t, false));
    const conf = ids("a", 100).map((t) => rawTx(t, true));
    const { fetchImpl, calls } = mempoolSpaceLike(mem, conf);
    const { client } = makeClient(fetchImpl);
    const out = await client.getAddressTxs("tb1qx");
    expect(out).toHaveLength(130);
    expect(out.filter((t) => t.status.confirmed)).toHaveLength(100);
    expect(new Set(out.map((t) => t.txid)).size).toBe(130);
    // page 1 (20 confirmed) -> cursor pages of 25: 20 + 25*3 = 95, then 5, short -> stop: 1 + 4 calls.
    expect(calls).toHaveLength(5);
    expect(calls[1]).toMatch(new RegExp(`/txs/chain/${conf[19]!.txid}$`));
  });

  it("60 mempool txs: page 1 is entirely mempool on mempool.space; confirmed history is fetched via /txs/chain without a cursor", async () => {
    const mem = ids("e", 60).map((t) => rawTx(t, false));
    const conf = ids("a", 10).map((t) => rawTx(t, true));
    const { fetchImpl, calls } = mempoolSpaceLike(mem, conf);
    const { client } = makeClient(fetchImpl);
    const out = await client.getAddressTxs("tb1qx");
    expect(out).toHaveLength(70); // the fake serves all 60 mempool txs on page 1; the point is that all 10 confirmed are recovered
    expect(out.filter((t) => t.status.confirmed)).toHaveLength(10);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/\/txs\/chain$/);
  });

  it("exactly 25 confirmed on plain Esplora costs one extra empty page and no error", async () => {
    const conf = ids("a", 25).map((t) => rawTx(t, true));
    const { fetchImpl, calls } = mempoolSpaceLike([], conf, 25);
    const { client } = makeClient(fetchImpl);
    expect(await client.getAddressTxs("tb1qx")).toHaveLength(25);
    expect(calls).toHaveLength(2);
  });

  it("3 mempool + 22 confirmed (25 total) checks one cursor page, which is empty", async () => {
    const mem = ids("e", 3).map((t) => rawTx(t, false));
    const conf = ids("a", 22).map((t) => rawTx(t, true));
    const { fetchImpl, calls } = mempoolSpaceLike(mem, conf, 25);
    const { client } = makeClient(fetchImpl);
    expect(await client.getAddressTxs("tb1qx")).toHaveLength(25);
    expect(calls).toHaveLength(2);
  });

  it("normaliseBaseUrl rejects malformed input with a typed error", () => {
    for (const bad of ["ht!tp://bad url", "ht tp://x y", "http://", "https://exa mple.com", "http://user:pw@host/", "http://bad_host/", "not a url at all"]) {
      let err: unknown;
      try {
        normaliseBaseUrl(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(EsploraUrlError);
      expect((err as EsploraUrlError).input).toBe(bad);
    }
    expect(() => normaliseBaseUrl("ht!tp://bad url")).toThrow(/not valid/);
    expect(() => normaliseBaseUrl("ftp://x")).toThrow(/must be http or https, not "ftp"/);
    expect(() => normaliseBaseUrl("ws://x")).toThrow(/must be http or https/);
    expect(() => normaliseBaseUrl("ht tp://x y")).toThrow(/not valid/);
    expect(() => normaliseBaseUrl("")).toThrow(/empty/);
    expect(() => new EsploraClient("ht!tp://bad url", { network: "signet" })).toThrow(EsploraUrlError);
    // Still accepts the forms users actually paste.
    expect(normaliseBaseUrl("HTTP://LocalHost:3002")).toBe("http://localhost:3002/");
    expect(normaliseBaseUrl("192.168.1.10:3002/api")).toBe("https://192.168.1.10:3002/api/");
    expect(normaliseBaseUrl("http://[::1]:3002")).toBe("http://[::1]:3002/");
    expect(normaliseBaseUrl("mempool.space/testnet4/api")).toBe("https://mempool.space/testnet4/api/");
  });

  it("txidOf computes the witness-stripped txid of the recorded signet transaction", () => {
    const hex = fixture("signet-tx-hex.txt").trim();
    expect(txidOf(hex)).toBe("7005f70d3ac295fbf5dbaec8ae8f72f33564c543a1a7edd0f609468c82c84260");
    expect(txidOf("deadbeef")).toBeUndefined();
  });

  describe("broadcast never reports failure for a tx the backend already has", () => {
    const hex = () => fixture("signet-tx-hex.txt").trim();
    const TXID = "7005f70d3ac295fbf5dbaec8ae8f72f33564c543a1a7edd0f609468c82c84260";

    it("POST lost then retry rejected with 'already known': verified via /tx/:txid/status", async () => {
      let posts = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (init?.method === "POST") {
          posts++;
          if (posts === 1) throw new TypeError("fetch failed");
          return new Response('sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}', { status: 400 });
        }
        if (url.endsWith(`/tx/${TXID}/status`)) return new Response(fixture("signet-tx-status.json"));
        return new Response("Not found", { status: 404 });
      };
      const { client } = makeClient(fetchImpl);
      expect(await client.broadcast(hex())).toBe(TXID);
      expect(posts).toBe(2);
    });

    it("'missing or spent inputs' after the tx was actually accepted: success", async () => {
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (init?.method === "POST") return new Response("sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent", { status: 400 });
        if (url.endsWith(`/tx/${TXID}/status`)) return new Response(JSON.stringify({ confirmed: false }));
        return new Response("Not found", { status: 404 });
      };
      const { client } = makeClient(fetchImpl);
      expect(await client.broadcast(hex())).toBe(TXID);
    });

    it("every POST attempt errors (5xx) but the backend has the tx: success", async () => {
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (init?.method === "POST") return new Response("upstream timeout", { status: 502 });
        if (url.endsWith(`/tx/${TXID}/status`)) return new Response(fixture("signet-tx-status.json"));
        return new Response("Not found", { status: 404 });
      };
      const { client } = makeClient(fetchImpl, { maxRetries: 1 });
      expect(await client.broadcast(hex())).toBe(TXID);
    });

    it("genuine rejection (backend does not have the tx): the verbatim rejection is surfaced, not the 404", async () => {
      const errors = fixtureJson<Record<string, { status: number; body: string }>>("error-responses.json");
      const notFound = errors["GET /tx/abab...ab (unknown txid)"]!;
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        if (init?.method === "POST") return new Response("sendrawtransaction RPC error -26: min relay fee not met", { status: 400 });
        return new Response(notFound.body, { status: notFound.status });
      };
      const { client } = makeClient(fetchImpl);
      const err = await client.broadcast(hex()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EsploraError);
      expect((err as EsploraError).body).toBe("sendrawtransaction RPC error -26: min relay fee not met");
      expect(calls).toEqual(["POST /signet/api/tx", `GET /signet/api/tx/${TXID}/status`]);
    });

    it("unparseable hex that the backend rejects is not looked up", async () => {
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        calls.push(init?.method ?? "GET");
        return new Response("TX decode failed", { status: 400 });
      };
      const { client } = makeClient(fetchImpl);
      await expect(client.broadcast("deadbeef")).rejects.toThrow(/TX decode failed/);
      expect(calls).toEqual(["POST"]);
    });

    it("user abort during broadcast is not turned into a lookup", async () => {
      const controller = new AbortController();
      const fetchImpl: typeof fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          controller.abort();
        });
      const { client } = makeClient(fetchImpl, { signal: controller.signal });
      await expect(client.broadcast(hex())).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});

describe("EsploraClient pacing (token bucket) and 429 policy", () => {
  const ok = (body = "1") => new Response(body);

  it("RateLimiter: one-second burst, then exact spacing; slowDown halves and expires", () => {
    let t = 0;
    const rl = new RateLimiter(8, () => t);
    const waits = Array.from({ length: 12 }, () => rl.reserve());
    expect(waits.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(waits.slice(8)).toEqual([125, 250, 375, 500]);
    t += 500; // everything reserved so far is now due
    expect(rl.rate).toBe(8);
    expect(rl.slowDown()).toBe(4);
    expect(rl.rate).toBe(4);
    expect(rl.slowedDown).toBe(true);
    expect(rl.reserve()).toBe(250); // no burst left; next slot at 1/4 s
    expect(rl.slowDown()).toBe(2); // halves again
    t += SLOW_DOWN_MS;
    expect(rl.rate).toBe(8); // restored
    expect(rl.slowedDown).toBe(false);
    expect(() => new RateLimiter(0)).toThrow();
  });

  it("paces requests at ratePerSecond (default 8) after the initial burst", async () => {
    const { fetchImpl } = mockFetch({ "blocks/tip/height": { body: "1" } });
    const { client, sleeps } = makePacedClient(fetchImpl);
    expect(DEFAULT_RATE_PER_SECOND).toBe(8);
    for (let i = 0; i < 20; i++) await client.getTipHeight();
    expect(sleeps).toHaveLength(12);
    expect(sleeps.every((ms) => ms === 125)).toBe(true);
  });

  it("429 without Retry-After: waits 2 s doubling, halves the rate each time, reports status, recovers", async () => {
    const { fetchImpl } = mockFetch({
      "blocks/tip/height": [{ status: 429, body: "" }, { status: 429, body: "" }, { body: "7" }],
    });
    const { client, sleeps, statuses, advance } = makePacedClient(fetchImpl, { maxRetries: 0 });
    expect(await client.getTipHeight()).toBe(7);
    expect(sleeps).toEqual([2000, 4000]);
    expect(statuses).toEqual([
      { kind: "slow-down", waitMs: 2000, ratePerSecond: 4, consecutive429s: 1, sinceLastSuccessMs: 0 },
      { kind: "slow-down", waitMs: 4000, ratePerSecond: 2, consecutive429s: 2, sinceLastSuccessMs: 2000 },
      { kind: "recovered", ratePerSecond: 2 },
    ]);
    expect(client.pacer.rate).toBe(2);
    advance(SLOW_DOWN_MS);
    expect(client.pacer.rate).toBe(8);
  });

  it("429 with Retry-After is honoured verbatim (capped at 120 s)", async () => {
    const { fetchImpl } = mockFetch({
      "blocks/tip/height": [{ status: 429, body: "", headers: { "retry-after": "7" } }, { status: 429, body: "", headers: { "retry-after": "999" } }, { body: "7" }],
    });
    const { client, sleeps } = makePacedClient(fetchImpl);
    expect(await client.getTipHeight()).toBe(7);
    expect(sleeps).toEqual([7000, 120_000]);
  });

  it("many consecutive 429s never fail on their own (maxRetries does not apply); backoff caps at 60 s", async () => {
    const routes = Array.from({ length: 10 }, () => ({ status: 429, body: "busy" }));
    const { fetchImpl, calls } = mockFetch({ "blocks/tip/height": [...routes, { body: "42" }] });
    const { client, sleeps } = makePacedClient(fetchImpl, { maxRetries: 0 });
    expect(await client.getTipHeight()).toBe(42);
    expect(calls).toHaveLength(11);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000]);
  });

  it("gives up only after the deadline passes with no successful response, with a 429 EsploraError", async () => {
    const { fetchImpl, calls } = mockFetch({ "blocks/tip/height": { status: 429, body: "busy" } });
    const { client, now } = makePacedClient(fetchImpl);
    const start = now();
    const err = await client.getTipHeight().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsploraError);
    expect((err as EsploraError).status).toBe(429);
    expect((err as EsploraError).body).toBe("busy");
    expect((err as Error).message).toMatch(/rate limited for 20 min with no progress/);
    expect(now() - start).toBeGreaterThanOrEqual(DEFAULT_RATE_LIMIT_DEADLINE_MS);
    expect(now() - start).toBeLessThan(DEFAULT_RATE_LIMIT_DEADLINE_MS + 60_000);
    expect(calls.length).toBeGreaterThan(20);
  });

  it("a success anywhere on the client resets the no-progress clock", async () => {
    let tipCalls = 0;
    let successAt: number | undefined;
    // eslint-disable-next-line prefer-const
    let paced: ReturnType<typeof makePacedClient>;
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/blocks/tip/height")) {
        tipCalls++;
        if (tipCalls === 5) {
          // 2+4+8+16 = 30 s of 429 waits so far. Another request now succeeds: the deadline must restart from here.
          await paced.client.getAddressUtxos("x");
          successAt = paced.now();
        }
        return new Response("busy", { status: 429 });
      }
      return ok("[]");
    };
    paced = makePacedClient(fetchImpl, { rateLimitDeadlineMs: 100_000 });
    const start = paced.now();
    const err = (await paced.client.getTipHeight().catch((e: unknown) => e)) as EsploraError;
    expect(err).toBeInstanceOf(EsploraError);
    expect(err.status).toBe(429);
    expect(successAt! - start).toBe(30_000);
    expect(paced.now() - successAt!).toBeGreaterThanOrEqual(100_000);
    expect(paced.now() - start).toBeGreaterThanOrEqual(130_000);
    // The utxo success counts as recovery client-wide (the UI indicator clears), then 429s resume.
    expect(paced.statuses.filter((st) => st.kind === "recovered")).toHaveLength(1);
  });

  it("reports 5xx retries through onStatus and never slows the bucket for them", async () => {
    const { fetchImpl } = mockFetch({ "blocks/tip/height": [{ status: 503, body: "" }, { body: "5" }] });
    const { client, statuses } = makePacedClient(fetchImpl, { backoffBaseMs: 100 });
    expect(await client.getTipHeight()).toBe(5);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ kind: "retry", status: 503, attempt: 1 });
    expect(client.pacer.rate).toBe(8);
  });

  it("user abort during a 429 wait is final", async () => {
    const controller = new AbortController();
    const { fetchImpl } = mockFetch({ "blocks/tip/height": { status: 429, body: "" } });
    const { client } = makePacedClient(fetchImpl, {
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    await expect(client.getTipHeight()).rejects.toMatchObject({ name: "AbortError" });
  });
});
