import type { Branch, DerivedAddress, OwnedUtxo, Purpose, ScanProgress, ScanResult } from "../../types";
import { EXTRA_BRANCHES, WALLET_BRANCHES, branchKey } from "../../types";
import type { Ctx } from "../app";
import { button, gloss, h, notice, replace, spinner } from "../dom";
import { KIND_LABEL, errorText, formatBtc, formatSats, scriptLabel, shortId } from "../format";
import { addressUrl, chainSources, txUrl } from "../logic";
import { ScanFailure, coinTypeOfPath, type ScanStatus, type TxView } from "../ports";
import { DEFAULT_WINDOW, SCAN_TIERS } from "../state";

type RowKey = `${0 | 1}/${string}`;
const EMPTY = "–";
/** Pause before automatically continuing after the server asked us to slow down. */
const SLOW_DOWN_SECONDS = 15;

function isRateLimit(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${e instanceof ScanFailure ? e.detail ?? "" : ""}` : String(e);
  return /\b429\b|too many requests|rate.?limit/i.test(text);
}

function minutesText(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const m = Math.round(seconds / 60);
  return m <= 1 ? "about a minute" : `about ${m} minutes`;
}

interface Row {
  count: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  found: HTMLElement;
  label: HTMLElement;
}

function isExtra(b: Branch): boolean {
  return EXTRA_BRANCHES.some((e) => e.purpose === b.purpose && e.change === b.change && e.kind === b.kind);
}

function sameBranch(a: DerivedAddress, b: Branch): boolean {
  return a.purpose === b.purpose && a.change === b.change && a.kind === b.kind;
}

/** Every branch of one account path, receive and change, including the rarely-used m/49' change encoding. */
function accountBranchesFor(purpose: Purpose): Branch[] {
  return [...WALLET_BRANCHES, ...EXTRA_BRANCHES].filter((b) => b.purpose === purpose);
}

export function renderScan(ctx: Ctx): HTMLElement {
  const { state, ports } = ctx;
  if (!state.seed) {
    ctx.go("seed");
    return h("div");
  }
  const seed = state.seed;
  // The client lives in state across steps; its pacing events are routed to whichever scan view is mounted.
  const sources = chainSources(state.network, state.useTrustedServers, state.sourceUrl);
  if (!state.client) state.client = ports.createChainClient(sources, state.network, (st) => state.chainStatus?.(st));
  const client = state.client;
  const multi = sources.length > 1;
  // What the prose calls the source: the trusted set spreads across servers; a single URL names its host.
  const host = multi ? `${sources.length} trusted public servers` : new URL(sources[0]!).host;
  const quick = ports.scanCost(state.network, SCAN_TIERS[0]!);

  // Live status line: lookups done this run, current rate, pacing notices.
  const lookupsEl = h("span", {}, "");
  const rateEl = h("span", {}, "");
  const serverEl = h("span", { class: "muted" }, "");
  const paceEl = h("span", { class: "throttled" }, "");
  const statusLine = h("div", { class: "statusline", "aria-live": "polite", hidden: true }, lookupsEl, rateEl, serverEl, paceEl);
  const runProgress = new Map<RowKey, number>();
  const samples: { t: number; n: number }[] = [];
  let throttled = false;
  let pacedRate: number | undefined;
  /** When the observed rate first went back above the paced rate; the notice clears after 10 s of that. */
  let recoveredSince: number | null = null;
  function resetStatus(): void {
    runProgress.clear();
    samples.length = 0;
    throttled = false;
    pacedRate = undefined;
    recoveredSince = null;
    lookupsEl.textContent = "0 lookups";
    rateEl.textContent = "";
    serverEl.textContent = multi ? `across ${sources.length} servers` : "";
    paceEl.textContent = "";
    statusLine.hidden = false;
  }
  function clearThrottle(): void {
    throttled = false;
    recoveredSince = null;
    paceEl.textContent = "";
  }
  function tickStatus(): void {
    let n = 0;
    for (const v of runProgress.values()) n += v;
    const now = performance.now();
    samples.push({ t: now, n });
    while (samples.length > 1 && now - samples[0]!.t > 10_000) samples.shift();
    const first = samples[0]!;
    const dt = (now - first.t) / 1000;
    const rate = dt >= 1 ? (n - first.n) / dt : null;
    lookupsEl.textContent = `${n.toLocaleString("en-GB")} lookups`;
    rateEl.textContent = rate !== null ? `${(rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10).toLocaleString("en-GB")} a second` : "";
    // Without an explicit "recovered" event, treat 10 s of running above the paced rate as recovery.
    if (throttled && rate !== null && pacedRate !== undefined && rate > pacedRate) {
      recoveredSince ??= now;
      if (now - recoveredSince >= 10_000) clearThrottle();
    } else {
      recoveredSince = null;
    }
    paceEl.textContent = throttled
      ? `the server asked us to slow down, continuing${pacedRate ? ` at ${pacedRate} lookups a second` : ""}`
      : "";
  }
  function onStatus(st: ScanStatus): void {
    throttled = st.throttled;
    pacedRate = st.ratePerSecond;
    recoveredSince = null;
    // In multi-server mode the label stays "across N servers"; a single custom
    // server has no rotation, so leave its (empty) label alone.
    if (!multi && st.server) serverEl.textContent = `via ${st.server}`;
    tickStatus();
  }
  state.chainStatus = onStatus;

  const progress = new Map<RowKey, ScanProgress>();
  const rows = new Map<RowKey, Row>();
  const cards = new Map<`${0 | 1}/${Purpose}`, HTMLElement>();
  // Per-account "scan this path deeper" controls, filled once a scan completes.
  const deepenSlots = new Map<`${0 | 1}/${Purpose}`, HTMLElement>();
  const kinds0 = h("div", { class: "kinds" });
  const kinds1Wrap = h("div", { hidden: true },
    h("p", { class: "small muted", style: "margin:1rem 0 0" }, "Also checking ", gloss("coin type 1", "a second set of paths (m/…'/1'/…) that some tools use for test networks; lnd itself always used coin type 0"), " paths, in case this wallet was created by another tool."),
  );
  const kinds1 = h("div", { class: "kinds" });
  kinds1Wrap.appendChild(kinds1);
  const summary = h("div", {});
  const status = h("div", {});
  const actions = h("div", { class: "actions" });
  const running = h("div", { class: "count", "aria-live": "polite" }, "Running total 0 sats");
  let controller: AbortController | null = null;

  function ensureRow(coinType: 0 | 1, b: Branch): Row {
    const key: RowKey = `${coinType}/${branchKey(b)}`;
    const existing = rows.get(key);
    if (existing) return existing;
    const cardKey = `${coinType}/${b.purpose}` as const;
    let card = cards.get(cardKey);
    if (!card) {
      const path = `m/${b.purpose}'/${coinType}'`;
      const purposeName = b.purpose === 49 ? "Nested SegWit" : b.purpose === 84 ? "Native SegWit" : "Taproot";
      const deepen = h("div", { class: "deepen" });
      deepenSlots.set(cardKey, deepen);
      card = h("section", { class: "kind", "aria-label": `Path ${path}` },
        h("header", {},
          h("span", { class: "kind-name" }, "Path ", h("span", { class: "mono" }, path)),
          h("span", { class: "small muted" }, `${purposeName} account`, gloss("", "the derivation path: which branch of the wallet's key tree these addresses come from")),
          deepen,
        ),
      );
      cards.set(cardKey, card);
      if (coinType === 1) kinds1Wrap.hidden = false;
      (coinType === 0 ? kinds0 : kinds1).appendChild(card);
    }
    const count = h("span", { class: "b-count" }, "0 checked");
    const found = h("span", { class: "b-found muted" }, EMPTY);
    const fill = h("span", { style: "width:0%" });
    const bar = h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0", "aria-label": `${b.change ? "change" : "receive"} ${scriptLabel(b.kind, state.network)} progress` }, fill);
    const label = h("span", { class: "b-label" },
      b.change ? "change, " : "receive, ",
      scriptLabel(b.kind, state.network),
      isExtra(b) ? h("span", { class: "tag" }, "rarely used") : null,
    );
    const row: Row = { count, bar, fill, found, label };
    rows.set(key, row);
    card.appendChild(h("div", { class: "branch" }, label, h("div", {}, count, bar), found));
    return row;
  }

  for (const b of WALLET_BRANCHES) ensureRow(0, b);

  function onProgress(p: ScanProgress): void {
    const key: RowKey = `${p.coinType}/${branchKey(p.branch)}`;
    progress.set(key, p);
    runProgress.set(key, p.scanned);
    tickStatus();
    const r = ensureRow(p.coinType, p.branch);
    // lnd semantics: the horizon moves out by a full window after every used address.
    const horizon = Math.max(p.window, p.lastUsedIndex + 1 + p.window);
    const pct = Math.min(100, Math.round((p.scanned / horizon) * 100));
    r.count.textContent = `${p.scanned.toLocaleString("en-GB")} checked`;
    r.fill.style.width = `${pct}%`;
    r.bar.setAttribute("aria-valuenow", String(pct));
    r.bar.classList.toggle("done", pct >= 100);
    if (p.utxosFound > 0) {
      r.found.className = "b-found";
      r.found.textContent = `${formatSats(p.satsFound)} in ${p.utxosFound}`;
    } else {
      r.found.className = "b-found muted";
      r.found.textContent = p.lastUsedIndex >= 0 ? "used, now empty" : EMPTY;
    }
    let sats = 0;
    for (const v of progress.values()) sats += v.satsFound;
    running.textContent = `Running total ${formatSats(sats)}`;
  }

  /** Mark every branch finished, except those `incomplete` says are not. */
  function markDone(result: ScanResult): void {
    const unfinished = new Set(ports.incompleteBranches(result, state.scanWindow).map((x) => `${x.coinType}/${branchKey(x.branch)}`));
    for (const [key, r] of rows) {
      const old = r.label.querySelector(".tag-warn");
      if (old) old.remove();
      if (unfinished.has(key)) {
        r.bar.classList.remove("done");
        r.label.appendChild(h("span", { class: "tag tag-warn" }, "unfinished"));
      } else {
        r.fill.style.width = "100%";
        r.bar.setAttribute("aria-valuenow", "100");
        r.bar.classList.add("done");
      }
    }
  }

  let slowTimer: ReturnType<typeof setInterval> | null = null;

  async function run(opts: { resumeFrom?: ScanResult | undefined; window?: number | undefined; branches?: readonly Branch[] | undefined; coinTypes?: readonly (0 | 1)[] | undefined; label?: string | undefined } = {}): Promise<void> {
    if (slowTimer) { clearInterval(slowTimer); slowTimer = null; }
    // The client is cached across scans; drop any cooldowns / give-up / throttle
    // state from a previous attempt so this one starts clean.
    client.reset?.();
    controller = new AbortController();
    const window = opts.window ?? state.scanWindow;
    // A per-path deepen scans only some branches; it must not move the baseline window
    // (that governs when other paths count as finished) nor scope-check against every path.
    const scoped = opts.branches;
    const text = opts.label
      ? opts.label
      : opts.resumeFrom && window > state.scanWindow
        ? `Widening every branch from ${state.scanWindow.toLocaleString("en-GB")} to ${window.toLocaleString("en-GB")} unused addresses. Only the new stretch is looked up.`
        : opts.resumeFrom
          ? "Continuing from where the last attempt stopped. Finished branches are not checked again."
          : `Checking addresses in order on each path, stopping after ${window} unused ones in a row. Looked up on ${host}.`;
    replace(status, spinner(text));
    replace(summary);
    replace(actions, button("Stop", () => controller?.abort(), { small: true }));
    for (const slot of deepenSlots.values()) replace(slot);
    resetStatus();
    try {
      const result = await ports.scan({ seed, network: state.network, client, window, resumeFrom: opts.resumeFrom, branches: opts.branches, coinTypes: opts.coinTypes, onProgress, signal: controller.signal });
      state.scan = result;
      if (!scoped) state.scanWindow = window;
      clearThrottle();
      replace(status);
      markDone(result);
      showSummary(result);
    } catch (e) {
      clearThrottle();
      const partial = e instanceof ScanFailure ? e.partial : opts.resumeFrom;
      const aborted = controller.signal.aborted || (e instanceof ScanFailure && e.aborted);
      if (partial) {
        state.scan = partial;
        markDone(partial);
      }
      const unfinished = partial ? ports.incompleteBranches(partial, window, scoped).length : 0;
      const cont = button("Continue the scan", () => void run({ resumeFrom: partial, window, branches: opts.branches, coinTypes: opts.coinTypes, label: opts.label }), { primary: true });
      if (aborted) {
        replace(status, notice("info",
          h("p", {}, h("strong", {}, "Scan stopped."), ` Nothing has been changed on chain.${partial ? ` What was found so far is shown below; ${unfinished} branch${unfinished === 1 ? " is" : "es are"} unfinished.` : ""}`),
        ));
      } else if (partial && isRateLimit(e)) {
        // Rate limiting is pacing, not failure: keep the results, wait, and carry on by ourselves.
        throttled = true;
        tickStatus();
        let left = SLOW_DOWN_SECONDS;
        const countdown = h("span", {}, `${left}`);
        replace(status, notice("info",
          h("p", {}, h("strong", {}, "The server asked us to slow down."), " Nothing is lost. Continuing in ", countdown, " seconds from exactly where it stopped. If this keeps happening, a self-hosted Esplora has no such limit."),
        ));
        slowTimer = setInterval(() => {
          left -= 1;
          countdown.textContent = String(left);
          if (left <= 0 && slowTimer) {
            clearInterval(slowTimer);
            slowTimer = null;
            void run({ resumeFrom: partial, window, branches: opts.branches, coinTypes: opts.coinTypes, label: opts.label });
          }
        }, 1000);
        showSummary(partial, { incomplete: unfinished > 0 });
        replace(actions, button("Continue now", () => void run({ resumeFrom: partial, window, branches: opts.branches, coinTypes: opts.coinTypes, label: opts.label }), { primary: true }), h("span", { class: "spacer" }), button("Stop", () => { if (slowTimer) { clearInterval(slowTimer); slowTimer = null; } replace(status, notice("info", h("p", {}, "Paused. Press Continue when you are ready."))); replace(actions, cont, h("span", { class: "spacer" }), button("Back", () => ctx.go("seed"))); }, { small: true }));
        return;
      } else {
        const detail = e instanceof ScanFailure && e.detail ? e.detail : undefined;
        replace(status, notice("error",
          h("p", {}, h("strong", {}, "The scan could not finish.")),
          h("p", {}, `The chain data source at ${host} stopped answering as expected. Check that the server is up and reachable and that it serves ${state.network}. What was found so far is kept; continuing picks up exactly where it stopped, so nothing is looked up twice.`),
          h("p", { class: "small muted mono" }, errorText(e)),
          detail ? h("p", { class: "small muted mono" }, detail) : null,
        ));
      }
      if (partial) showSummary(partial, { incomplete: unfinished > 0 });
      replace(actions, partial ? cont : button("Scan again", () => void run(), { primary: true }), h("span", { class: "spacer" }), button(aborted ? "Back" : "Change data source", () => ctx.go(aborted ? "seed" : "start")));
      cont.focus();
    } finally {
      controller = null;
    }
  }

  /**
   * Fill each account card's "scan this path deeper" control. A path that stopped at the
   * 100-unused gap can be pushed on its own to lnd's full 2,500 window, in case a coin
   * sits beyond the gap. Dead paths are left alone unless the user asks; only the path
   * they choose is looked up further, so there is no repeat of scanning every path to 2,500.
   */
  function refreshDeepenControls(result: ScanResult): void {
    for (const [cardKey, slot] of deepenSlots) {
      const [ctStr, pStr] = cardKey.split("/");
      const coinType = Number(ctStr) as 0 | 1;
      const purpose = Number(pStr) as Purpose;
      const branches = accountBranchesFor(purpose);
      const c = ports.scanCost(state.network, DEFAULT_WINDOW, result, { branches, coinTypes: [coinType] });
      if (c.requests > 0) {
        const label = `Deepening the m/${purpose}' path to lnd's full recovery window of ${DEFAULT_WINDOW.toLocaleString("en-GB")} unused addresses in a row. Only this path is looked up.`;
        replace(slot,
          button("Scan this path deeper", () => void run({ resumeFrom: result, window: DEFAULT_WINDOW, branches, coinTypes: [coinType], label }), { small: true }),
          h("span", { class: "est" }, `to lnd's window of ${DEFAULT_WINDOW.toLocaleString("en-GB")}, about ${c.requests.toLocaleString("en-GB")} more lookups, ${minutesText(c.seconds)}`),
        );
      } else {
        replace(slot, h("span", { class: "est muted" }, `Checked to lnd's full window of ${DEFAULT_WINDOW.toLocaleString("en-GB")}.`));
      }
    }
  }

  function showSummary(result: ScanResult, flags: { incomplete?: boolean } = {}): void {
    const unconfirmed = result.utxos.filter((u) => !u.status.confirmed);
    const unconfirmedSats = unconfirmed.reduce((a, u) => a + u.value, 0);
    const confirmedSats = result.totalSats - unconfirmedSats;
    const byKind = (["np2wkh", "p2wkh", "p2tr"] as const).map((k) => ({ kind: k, utxos: result.utxos.filter((u) => u.owner.kind === k) })).filter((x) => x.utxos.length > 0);
    const depthMax = Math.max(...Object.values(result.depth).map((d) => d ?? 0), 0);
    const n = result.utxos.length;

    const next = button("Continue to sweep", () => ctx.go("sweep"), { primary: true });
    const nextReason = h("span", { class: "reason" });
    function refreshNext(): void {
      const sweepable = confirmedSats + (state.includeUnconfirmed ? unconfirmedSats : 0);
      next.disabled = sweepable <= 0;
      nextReason.textContent = result.totalSats === 0
        ? "Nothing to sweep."
        : sweepable <= 0
          ? "Everything found is unconfirmed. Tick the box above to include it, or wait for a block and scan again."
          : "";
    }

    const include = h("input", { type: "checkbox", id: "include-unconfirmed", checked: state.includeUnconfirmed }) as HTMLInputElement;
    include.addEventListener("change", () => { state.includeUnconfirmed = include.checked; refreshNext(); });

    replace(summary,
      h("div", { class: "total" },
        ...(result.totalSats > 0
          ? [
              h("div", { class: "muted small" }, flags.incomplete ? "Found so far (scan unfinished)" : "Found on this wallet"),
              h("div", { class: "big" }, formatBtc(result.totalSats)),
              h("div", { class: "sub" }, `${formatSats(result.totalSats)} in ${n} unspent output${n === 1 ? "" : "s"}`),
            ]
          : [
              h("div", { class: "big" }, flags.incomplete ? "Nothing found so far" : "Nothing found"),
              h("div", { class: "sub" }, flags.incomplete ? "The scan did not finish; continue it before drawing conclusions." : `No unspent coins within ${state.scanWindow.toLocaleString("en-GB")} unused addresses of the last used one on any branch (checked to index ${depthMax.toLocaleString("en-GB")}).`),
            ]),
        byKind.length > 1
          ? h("dl", { class: "kv" }, ...byKind.flatMap((x) => [h("dt", {}, `${KIND_LABEL[x.kind]} (${x.utxos.length})`), h("dd", {}, formatSats(x.utxos.reduce((a, u) => a + u.value, 0)))]))
          : null,
      ),
      unconfirmed.length > 0
        ? notice("warn",
            h("p", {}, h("strong", {}, `${formatSats(unconfirmedSats)} of this is unconfirmed`), ` (${unconfirmed.length} output${unconfirmed.length === 1 ? "" : "s"} still waiting for a block). If the transaction paying it is dropped or replaced before it confirms, a sweep that includes it fails too. The safe choice is to wait and scan again.`),
            h("div", { class: "check" }, include, h("label", { for: "include-unconfirmed" }, "Include the unconfirmed outputs in the sweep anyway. I understand the risk.")),
          )
        : null,
      result.totalSats === 0 && !flags.incomplete
        ? notice("info", h("p", {}, `Nothing within ${state.scanWindow.toLocaleString("en-GB")} unused addresses in a row on any path. Before concluding the wallet is empty: a path shown as "used, now empty" held coins that have since moved, and a node that generated many addresses without using them can leave a gap longer than ${state.scanWindow.toLocaleString("en-GB")}. If either might apply, use "Scan this path deeper" on that path above to follow it to lnd's full recovery window of ${DEFAULT_WINDOW.toLocaleString("en-GB")}. It can also mean the coins were already moved, the seed belongs to a different node, or the wrong network is selected.`))
        : null,
      detailsPanel(result),
    );

    if (!flags.incomplete) {
      refreshDeepenControls(result);
      refreshNext();
      replace(actions, next, nextReason, h("span", { class: "spacer" }), button("Back", () => ctx.go("seed")));
      next.focus();
    }
  }

  function detailsPanel(result: ScanResult): HTMLElement {
    const body = h("div", { class: "body" });
    const details = h("details", { class: "panel" }, h("summary", {}, "Show addresses, unspent outputs and transactions"), body);
    let loaded = false;
    details.addEventListener("toggle", () => {
      if (!details.open || loaded) return;
      loaded = true;
      fillDetails(body, result);
    });
    return details;
  }

  function fillDetails(body: HTMLElement, result: ScanResult): void {
    const txHolder = h("div", {}, spinner("Loading transactions"));
    replace(body,
      h("h3", {}, "Unspent outputs (", gloss("UTXOs", "unspent transaction outputs: the individual coins the wallet can still spend, each created by an earlier transaction"), `), ${result.utxos.length}`),
      result.utxos.length ? h("ul", { class: "list" }, ...result.utxos.map(utxoItem)) : h("p", { class: "muted small" }, "None."),
      h("h3", {}, `Addresses with history (${result.usedAddresses.length})`),
      result.usedAddresses.length ? h("ul", { class: "list" }, ...result.usedAddresses.map(addressItem)) : h("p", { class: "muted small" }, "None. Every address checked was never used."),
      h("h3", {}, "Transactions"),
      txHolder,
    );
    void loadTxs(txHolder, result.usedAddresses);
  }

  async function loadTxs(holder: HTMLElement, addrs: DerivedAddress[]): Promise<void> {
    if (addrs.length === 0) {
      replace(holder, h("p", { class: "muted small" }, "None."));
      return;
    }
    try {
      const txs = await ports.fetchTransactions(client, addrs);
      replace(holder, txs.length ? h("ul", { class: "list" }, ...txs.map(txItem)) : h("p", { class: "muted small" }, "None."));
    } catch (e) {
      replace(holder, notice("error", h("p", {}, "Could not load transactions. ", errorText(e))));
    }
  }

  function txItem(tx: TxView): HTMLElement {
    const net = tx.netSats;
    return h("li", {},
      h("div", { class: "row" },
        txLink(tx.txid),
        h("span", { class: "inline" },
          net !== undefined ? h("span", { class: net >= 0 ? "" : "muted" }, `${net >= 0 ? "+" : "−"}${formatSats(Math.abs(net))}`) : null,
          tx.status.confirmed ? h("span", { class: "tag tag-ok" }, `block ${tx.status.blockHeight?.toLocaleString("en-GB") ?? ""}`) : h("span", { class: "tag tag-warn" }, "unconfirmed"),
        ),
      ),
      h("div", { class: "small muted" }, `fee ${formatSats(tx.fee)}, ${tx.vin.length} in, ${tx.vout.length} out`),
    );
  }

  function txLink(txid: string): HTMLElement {
    return h("a", { class: "mono", href: txUrl(state.sourceUrl, txid), target: "_blank", rel: "noopener", title: txid }, shortId(txid, 10, 10));
  }

  function utxoItem(u: OwnedUtxo): HTMLElement {
    return h("li", {},
      h("div", { class: "row" }, h("span", {}, formatSats(u.value)), u.status.confirmed ? h("span", { class: "tag tag-ok" }, `confirmed, block ${u.status.blockHeight?.toLocaleString("en-GB") ?? ""}`) : h("span", { class: "tag tag-warn" }, "unconfirmed")),
      h("div", { class: "addr small" }, h("a", { href: addressUrl(state.sourceUrl, u.owner.address), target: "_blank", rel: "noopener" }, u.owner.address)),
      h("div", { class: "small muted" }, h("span", { class: "mono" }, u.owner.path), ` (${scriptLabel(u.owner.kind, state.network)}) · `, txLink(u.txid), h("span", { class: "mono" }, `:${u.vout}`)),
    );
  }

  function addressItem(a: DerivedAddress): HTMLElement {
    return h("li", {},
      h("div", { class: "addr small" }, h("a", { href: addressUrl(state.sourceUrl, a.address), target: "_blank", rel: "noopener" }, a.address)),
      h("div", { class: "small muted mono" }, a.path),
    );
  }

  function replay(result: ScanResult): void {
    const all: Branch[] = [...WALLET_BRANCHES, ...EXTRA_BRANCHES];
    const passes: [0 | 1, Partial<Record<string, number>> | undefined][] = [[0, result.depth], [1, result.depthCoin1]];
    for (const [coinType, depth] of passes) {
      if (!depth) continue;
      for (const b of all) {
        const d = depth[branchKey(b)];
        if (d === undefined) continue;
        const mine = result.utxos.filter((u) => sameBranch(u.owner, b) && coinTypeOfPath(u.owner.path) === coinType);
        const usedIdx = result.usedAddresses.filter((a) => sameBranch(a, b) && coinTypeOfPath(a.path) === coinType).map((a) => a.index);
        onProgress({ coinType, branch: b, scanned: d, window: state.scanWindow, lastUsedIndex: Math.max(-1, ...usedIdx), utxosFound: mine.length, satsFound: mine.reduce((a, u) => a + u.value, 0) });
      }
    }
    markDone(result);
  }

  if (state.scan) {
    replay(state.scan);
    statusLine.hidden = true;
    const unfinished = ports.incompleteBranches(state.scan, state.scanWindow).length;
    if (unfinished > 0) {
      const partial = state.scan;
      replace(status, notice("info", h("p", {}, `${unfinished} branch${unfinished === 1 ? " is" : "es are"} unfinished from the last attempt.`)));
      showSummary(partial, { incomplete: true });
      replace(actions, button("Continue the scan", () => void run({ resumeFrom: partial }), { primary: true }), h("span", { class: "spacer" }), button("Back", () => ctx.go("seed")));
    } else {
      showSummary(state.scan);
    }
  } else {
    queueMicrotask(() => void run());
  }

  return h("section", {},
    h("h1", {}, "Looking for funds"),
    h("p", { class: "lede" }, `lnd kept its coins on three key paths, each with a receive branch and a change branch. Every address on them is looked up on ${host}.`),
    h("p", { class: "small muted" }, `Like any wallet, this checks addresses in order and stops a path after ${SCAN_TIERS[0]} unused ones in a row, moving the finish line ${SCAN_TIERS[0]} further out each time it finds a used one, so a busy path is followed as deep as it goes: about ${quick.requests.toLocaleString("en-GB")} lookups on an empty wallet, ${minutesText(quick.seconds)} on a public server. Afterwards, if one path looks used but you suspect coins beyond the gap, you can scan that single path deeper to lnd's full recovery window of ${DEFAULT_WINDOW.toLocaleString("en-GB")} without re-checking the others. You can stop at any time and continue later.`),
    statusLine,
    running,
    kinds0,
    kinds1Wrap,
    status,
    summary,
    actions,
  );
}
