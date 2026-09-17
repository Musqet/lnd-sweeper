import type { Branch, BranchKey, DerivedAddress, Network, OwnedUtxo, Purpose, ScanProgress, ScanResult } from "../../types";
import { EXTRA_BRANCHES, WALLET_BRANCHES, branchKey } from "../../types";
import type { Ctx } from "../app";
import { button, copyText, field, gloss, h, notice, replace, spinner } from "../dom";
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

/**
 * Fold one found address and its UTXOs into an existing scan result (or a fresh
 * one), de-duplicated by outpoint, so the found coin joins the running total and
 * the sweep step picks it up like any other. The branch depth is set past the
 * found index so the summary reflects how deep we reached on that path.
 */
function foldFound(base: ScanResult | null, owner: DerivedAddress, utxos: OwnedUtxo[], network: Network): ScanResult {
  const coinType = coinTypeOfPath(owner.path);
  const bkey = branchKey({ purpose: owner.purpose, change: owner.change, kind: owner.kind });
  const seen = new Set((base?.utxos ?? []).map((u) => `${u.txid}:${u.vout}`));
  const added = utxos.filter((u) => !seen.has(`${u.txid}:${u.vout}`));
  const utxosAll = [...(base?.utxos ?? []), ...added];
  const usedHas = (base?.usedAddresses ?? []).some((a) => a.address === owner.address);
  const depth = { ...(base?.depth ?? {}) };
  const depthCoin1 = { ...(base?.depthCoin1 ?? {}) };
  const table = coinType === 0 ? depth : depthCoin1;
  table[bkey] = Math.max(table[bkey] ?? 0, owner.index + 1);
  const result: ScanResult = {
    network: base?.network ?? network,
    utxos: utxosAll,
    usedAddresses: usedHas ? (base?.usedAddresses ?? []) : [...(base?.usedAddresses ?? []), owner],
    totalSats: utxosAll.reduce((a, u) => a + u.value, 0),
    depth,
  };
  if (coinType === 1 || base?.depthCoin1) result.depthCoin1 = depthCoin1;
  return result;
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
    card.appendChild(h("div", { class: "branch" }, label, h("div", { class: "branch-main" }, count, bar, found)));
    return row;
  }

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
    const unused = Math.max(0, p.scanned - (p.lastUsedIndex + 1));
    const usedText = p.usedCount === 1 ? "1 used" : `${p.usedCount.toLocaleString("en-GB")} used`;
    const unusedText = `${unused.toLocaleString("en-GB")} unused since`;
    if (p.utxosFound > 0) {
      r.found.className = "b-found";
      r.found.textContent = `${formatSats(p.satsFound)} in ${p.utxosFound === 1 ? "1 output" : `${p.utxosFound} outputs`} · ${usedText}, ${unusedText}`;
    } else if (p.usedCount > 0) {
      r.found.className = "b-found muted";
      r.found.textContent = `${usedText}, now empty · ${unusedText}`;
    } else {
      r.found.className = "b-found muted";
      r.found.textContent = p.scanned > 0 ? `none used · ${p.scanned.toLocaleString("en-GB")} unused` : EMPTY;
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

  async function run(opts: { resumeFrom?: ScanResult | undefined; window?: number | undefined; branches?: readonly Branch[] | undefined; coinTypes?: readonly (0 | 1)[] | undefined; startFrom?: Partial<Record<BranchKey, number>> | undefined; label?: string | undefined } = {}): Promise<void> {
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
    // Show the rows for the branches this run will scan straight away (coin 0 cards).
    for (const b of opts.branches ?? WALLET_BRANCHES) ensureRow(0, b);
    resetStatus();
    try {
      const result = await ports.scan({ seed, network: state.network, client, window, resumeFrom: opts.resumeFrom, branches: opts.branches, coinTypes: opts.coinTypes, startFrom: opts.startFrom, onProgress, signal: controller.signal });
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
      const cont = button("Continue the scan", () => void run({ resumeFrom: partial, window, branches: opts.branches, coinTypes: opts.coinTypes, startFrom: opts.startFrom, label: opts.label }), { primary: true });
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
            void run({ resumeFrom: partial, window, branches: opts.branches, coinTypes: opts.coinTypes, startFrom: opts.startFrom, label: opts.label });
          }
        }, 1000);
        showSummary(partial, { incomplete: unfinished > 0 });
        replace(actions, button("Continue now", () => void run({ resumeFrom: partial, window, branches: opts.branches, coinTypes: opts.coinTypes, startFrom: opts.startFrom, label: opts.label }), { primary: true }), h("span", { class: "spacer" }), button("Stop", () => { if (slowTimer) { clearInterval(slowTimer); slowTimer = null; } replace(status, notice("info", h("p", {}, "Paused. Press Continue when you are ready."))); replace(actions, cont, h("span", { class: "spacer" }), button("Back", () => ctx.go("seed"))); }, { small: true }));
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
  /** How deep this account path has been scanned (max index reached across its branches, for one coin type). */
  function accountDepth(result: ScanResult, coinType: 0 | 1, branches: readonly Branch[]): number {
    const table = coinType === 0 ? result.depth : (result.depthCoin1 ?? {});
    let m = 0;
    for (const b of branches) m = Math.max(m, table[branchKey(b)] ?? 0);
    return m;
  }

  function refreshDeepenControls(result: ScanResult): void {
    for (const [cardKey, slot] of deepenSlots) {
      const [ctStr, pStr] = cardKey.split("/");
      const coinType = Number(ctStr) as 0 | 1;
      const purpose = Number(pStr) as Purpose;
      const branches = accountBranchesFor(purpose);
      const curDepth = accountDepth(result, coinType, branches);
      // The first deepen goes to lnd's own 2,500 recovery window. Further presses
      // keep walking outward by another window each time, with no ceiling: a wallet
      // that was restored leaves a gap the size of the recovery window, then resumes
      // just past it, so the used indices sit in islands ~2,500 apart. A fixed 2,500
      // scan cannot bridge its own gap; rolling the window out past the current depth
      // follows the wallet island by island until a genuine 2,500-unused run.
      const firstStep = curDepth < DEFAULT_WINDOW;
      const target = firstStep ? DEFAULT_WINDOW : curDepth + DEFAULT_WINDOW;
      const c = ports.scanCost(state.network, target, result, { branches, coinTypes: [coinType] });
      if (c.requests <= 0) { replace(slot); continue; }
      const label = firstStep
        ? `Deepening the m/${purpose}' path to lnd's full recovery window of ${DEFAULT_WINDOW.toLocaleString("en-GB")} unused addresses in a row. Only this path is looked up.`
        : `Following the m/${purpose}' path past index ${curDepth.toLocaleString("en-GB")} to ${target.toLocaleString("en-GB")}, another ${DEFAULT_WINDOW.toLocaleString("en-GB")} addresses, in case the node was restored and resumed beyond a gap. Only this path is looked up.`;
      replace(slot,
        button(firstStep ? "Scan this path deeper" : "Scan deeper still", () => void run({ resumeFrom: result, window: target, branches, coinTypes: [coinType], label }), { small: true }),
        h("span", { class: "est" }, `to index ${target.toLocaleString("en-GB")}, about ${c.requests.toLocaleString("en-GB")} more lookups, ${minutesText(c.seconds)}`),
      );
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
        ? notice("info", h("p", {}, `Nothing within ${state.scanWindow.toLocaleString("en-GB")} unused addresses in a row on any path. Before concluding the wallet is empty: a path shown as "used, now empty" held coins that have since moved, and a node that generated many addresses without using them can leave a gap longer than ${state.scanWindow.toLocaleString("en-GB")}. If either might apply, use "Scan this path deeper" on that path above to follow it to lnd's full recovery window of ${DEFAULT_WINDOW.toLocaleString("en-GB")}. If you know the exact address a coin is on, for example an output from a channel close, use "Find a specific address" under Advanced recovery tools below, which finds it however deep it sits. It can also mean the coins were already moved, the seed belongs to a different node, or the wrong network is selected.`))
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
        onProgress({ coinType, branch: b, scanned: d, window: state.scanWindow, lastUsedIndex: Math.max(-1, ...usedIdx), usedCount: usedIdx.length, utxosFound: mine.length, satsFound: mine.reduce((a, u) => a + u.value, 0) });
      }
    }
    markDone(result);
  }

  /** Fetch the found address's UTXOs, fold them into the result and repaint the summary. */
  async function applyFound(owner: DerivedAddress): Promise<{ empty: true } | { empty: false; sats: number; n: number }> {
    const raw = await client.getAddressUtxos(owner.address);
    if (raw.length === 0) return { empty: true };
    const owned: OwnedUtxo[] = raw.map((u) => ({ ...u, owner }));
    const merged = foldFound(state.scan, owner, owned, state.network);
    state.scan = merged;
    if (controller) controller.abort();
    statusLine.hidden = true;
    replay(merged);
    showSummary(merged);
    summary.scrollIntoView({ behavior: "smooth", block: "start" });
    return { empty: false, sats: owned.reduce((a, u) => a + u.value, 0), n: owned.length };
  }

  /** Advanced tools: locate a known address beyond the gap scan, and reveal the master xprv. */
  function advancedTools(): HTMLElement {
    const addr = h("input", { type: "text", class: "mono", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: state.network === "mainnet" ? "bc1p… or bc1q…" : "" }) as HTMLInputElement;
    const maxInput = h("input", { type: "number", min: "1000", step: "1000", value: "100000", style: "max-width:10rem" }) as HTMLInputElement;
    const findMsg = h("div", { class: "hint", "aria-live": "polite" });
    const findBtn = button("Find address", () => void find(), { small: true });
    const findActions = h("div", { class: "est" }, findBtn);
    let findCtrl: AbortController | null = null;

    async function find(): Promise<void> {
      const target = addr.value.trim();
      if (target === "") { findMsg.textContent = "Paste the address a coin is on, for example the output of a channel close."; return; }
      const maxIndex = Math.min(1_000_000, Math.max(1000, Math.floor(Number(maxInput.value) || 100_000)));
      findCtrl = new AbortController();
      findBtn.disabled = true;
      const stop = button("Stop", () => findCtrl?.abort(), { small: true });
      replace(findActions, stop);
      findMsg.style.color = "";
      findMsg.textContent = "Deriving addresses…";
      try {
        const res = await ports.findAddress({
          seed, network: state.network, target, maxIndex, signal: findCtrl.signal,
          onProgress: (s, t) => { findMsg.textContent = `Deriving addresses… ${Math.floor((s / t) * 100)}%`; },
        });
        if (!res.found) {
          findMsg.style.color = "var(--danger)";
          findMsg.textContent =
            res.reason === "invalid" ? res.detail ?? "That is not a valid address for this network."
            : res.reason === "not-wallet-kind" ? res.detail ?? "That address type is not one lnd's wallet derives."
            : `Not found within ${maxIndex.toLocaleString("en-GB")} addresses on the matching paths. If you expect it to be deeper still, raise the index limit and search again.`;
          return;
        }
        findMsg.style.color = "";
        const idx = res.owner.index;
        const idxNode = () => h("strong", {}, idx.toLocaleString("en-GB"));
        const pathNode = () => h("span", { class: "mono" }, res.owner.path);
        replace(findMsg, "Found at index ", idxNode(), " (", pathNode(), "). Checking for coins…");
        const r = await applyFound(res.owner);
        const deepHint = ' To catch other coins on this path, use "Scan this path deeper" above, which now follows it past this index.';
        if (r.empty) {
          replace(findMsg, "This address is at index ", idxNode(), " (", pathNode(), "), but it holds no unspent coins now.", deepHint);
        } else {
          replace(findMsg, "Found ", h("strong", {}, formatSats(r.sats)), " at index ", idxNode(), " (", pathNode(), "). Added to the total above; continue to sweep.", deepHint);
        }
      } catch (e) {
        if (findCtrl.signal.aborted) { findMsg.textContent = "Search stopped."; return; }
        findMsg.style.color = "var(--danger)";
        findMsg.textContent = errorText(e);
      } finally {
        findBtn.disabled = false;
        replace(findActions, findBtn);
        findCtrl = null;
      }
    }

    const xprvBox = h("div", { class: "xprv-box" });
    function showXprv(): void {
      const xprv = ports.masterXprv(seed, state.network);
      const ta = h("textarea", { readonly: "true", rows: "3", class: "mono xprv", "aria-label": "Master extended private key" }) as HTMLTextAreaElement;
      ta.value = xprv;
      const copied = h("span", { class: "est muted" }, "");
      const copyBtn = button("Copy", () => void copyText(xprv).then((ok) => { copied.textContent = ok ? "copied" : "copy failed"; }), { small: true });
      replace(xprvBox,
        notice("warn", h("p", {}, h("strong", {}, "This is the private key to the whole wallet."), " Anyone who has it can spend every coin. Only paste it into wallet software and a device you trust, and clear it afterwards.")),
        ta,
        h("div", { class: "est" }, copyBtn, copied),
        h("p", { class: "small muted" }, "To import into Sparrow: New Wallet, script type Taproot, paste this key, set the derivation to ", h("span", { class: "mono" }, "m/86'/0'/0'"), ". Raise Sparrow's gap limit well above where you expect the address, or it will not be found."),
      );
    }
    replace(xprvBox, button("Show master private key (xprv)", () => showXprv(), { small: true, danger: true }));

    return h("details", { class: "panel advanced" },
      h("summary", {}, "Advanced recovery tools"),
      h("div", { class: "body" },
        h("h3", {}, "Find a specific address"),
        h("p", { class: "small muted" }, "If you know the exact address a coin is on, for example a Taproot output from a cooperative channel close, paste it here. It is matched by deriving this wallet's addresses locally, with no lookups, so it finds the path however deep the address is, past the gap that stops the scan above."),
        field("Address to find", addr),
        field("Search up to index", maxInput, "How many addresses to try on each matching path. Raise it if a deep address is not found."),
        findActions,
        findMsg,
        h("h3", { style: "margin-top:1.5rem" }, "Master private key"),
        h("p", { class: "small muted" }, "Export this wallet's root key to import it into another wallet, such as Sparrow. lnd's aezeed words are not BIP39, so the words cannot be typed into Sparrow directly; this key is the bridge."),
        xprvBox,
      ),
    );
  }

  const config = h("div", {});

  /**
   * Pre-scan controls: which account paths to scan, and a start index per path to
   * skip low addresses already known empty. Defaults scan every path from index 0.
   */
  function renderConfig(): void {
    const purposes: { purpose: Purpose; name: string }[] = [
      { purpose: 49, name: "Nested SegWit" },
      { purpose: 84, name: "Native SegWit" },
      { purpose: 86, name: "Taproot" },
    ];
    const rowsCfg = purposes.map(({ purpose, name }) => {
      const check = h("input", { type: "checkbox", id: `scan-${purpose}`, checked: true }) as HTMLInputElement;
      const startInput = h("input", { type: "number", min: "0", step: "1", value: "0", id: `start-${purpose}`, "aria-label": `m/${purpose}' start index`, style: "max-width:8rem" }) as HTMLInputElement;
      check.addEventListener("change", () => { startInput.disabled = !check.checked; refresh(); });
      startInput.addEventListener("input", refresh);
      return { purpose, name, check, startInput };
    });
    const coin1 = h("input", { type: "checkbox", id: "scan-coin1", checked: true }) as HTMLInputElement;
    coin1.addEventListener("change", refresh);

    const costLine = h("div", { class: "hint" });
    const startBtn = button("Start scan", () => start(), { primary: true });

    function selection(): { branches: Branch[]; coinTypes: (0 | 1)[]; startFrom: Partial<Record<BranchKey, number>> } {
      const branches: Branch[] = [];
      const startFrom: Partial<Record<BranchKey, number>> = {};
      for (const r of rowsCfg) {
        if (!r.check.checked) continue;
        const start = Math.max(0, Math.floor(Number(r.startInput.value) || 0));
        for (const b of accountBranchesFor(r.purpose)) {
          branches.push(b);
          if (start > 0) startFrom[branchKey(b)] = start;
        }
      }
      const coinTypes: (0 | 1)[] = state.network === "mainnet" ? [0] : coin1.checked ? [0, 1] : [0];
      return { branches, coinTypes, startFrom };
    }

    function refresh(): void {
      const { branches, coinTypes, startFrom } = selection();
      startBtn.disabled = branches.length === 0;
      if (branches.length === 0) { costLine.textContent = "Choose at least one path to scan."; return; }
      const c = ports.scanCost(state.network, state.scanWindow, undefined, { branches, coinTypes, startFrom });
      costLine.textContent = `About ${c.requests.toLocaleString("en-GB")} lookups, ${minutesText(c.seconds)} on ${host}.`;
    }

    function start(): void {
      const { branches, coinTypes, startFrom } = selection();
      if (branches.length === 0) return;
      state.scanBranches = branches;
      state.scanCoinTypes = coinTypes;
      state.scanStartFrom = Object.keys(startFrom).length > 0 ? startFrom : null;
      replace(config);
      void run({ branches, coinTypes, ...(state.scanStartFrom ? { startFrom: state.scanStartFrom } : {}) });
    }

    replace(config,
      h("div", { class: "panel scan-config" },
        h("div", { class: "body" },
          h("h3", {}, "Paths to scan"),
          h("p", { class: "small muted" }, "Every path is checked from the start by default. Untick a path you know is empty, or set a start index to skip low addresses you have already checked (for example a wallet that was restored and only used addresses beyond a gap)."),
          ...rowsCfg.map((r) =>
            h("div", { class: "cfg-row" },
              h("label", { class: "cfg-path", for: `scan-${r.purpose}` }, r.check, h("span", {}, h("span", { class: "mono" }, `m/${r.purpose}'`), ` ${r.name}`)),
              h("label", { class: "cfg-start", for: `start-${r.purpose}` }, "start index ", r.startInput),
            ),
          ),
          state.network === "mainnet" ? null : h("div", { class: "cfg-row" }, h("label", { class: "cfg-path", for: "scan-coin1" }, coin1, h("span", {}, "Also check coin-type 1 paths"))),
          h("div", { class: "est" }, startBtn, costLine),
        ),
      ),
    );
    refresh();
  }

  if (state.scan) {
    replay(state.scan);
    statusLine.hidden = true;
    const unfinished = ports.incompleteBranches(state.scan, state.scanWindow, state.scanBranches ?? undefined).length;
    if (unfinished > 0) {
      const partial = state.scan;
      const resumeOpts = { resumeFrom: partial, ...(state.scanBranches ? { branches: state.scanBranches } : {}), ...(state.scanCoinTypes ? { coinTypes: state.scanCoinTypes } : {}), ...(state.scanStartFrom ? { startFrom: state.scanStartFrom } : {}) };
      replace(status, notice("info", h("p", {}, `${unfinished} branch${unfinished === 1 ? " is" : "es are"} unfinished from the last attempt.`)));
      showSummary(partial, { incomplete: true });
      replace(actions, button("Continue the scan", () => void run(resumeOpts), { primary: true }), h("span", { class: "spacer" }), button("Back", () => ctx.go("seed")));
    } else {
      showSummary(state.scan);
    }
  } else {
    renderConfig();
  }

  return h("section", {},
    h("h1", {}, "Looking for funds"),
    h("p", { class: "lede" }, `lnd kept its coins on three key paths, each with a receive branch and a change branch. Every address on them is looked up on ${host}.`),
    h("p", { class: "small muted" }, `Like any wallet, this checks addresses in order and stops a path after ${SCAN_TIERS[0]} unused ones in a row, moving the finish line ${SCAN_TIERS[0]} further out each time it finds a used one, so a busy path is followed as deep as it goes: about ${quick.requests.toLocaleString("en-GB")} lookups on an empty wallet, ${minutesText(quick.seconds)} on a public server. Afterwards, if one path looks used but you suspect coins beyond the gap, you can scan that single path deeper: first to lnd's own recovery window of ${DEFAULT_WINDOW.toLocaleString("en-GB")}, then further still in ${DEFAULT_WINDOW.toLocaleString("en-GB")}-address steps with no ceiling, which follows a wallet that was restored and resumed past a gap. Only that path is re-checked. You can stop at any time and continue later.`),
    config,
    statusLine,
    running,
    kinds0,
    kinds1Wrap,
    status,
    summary,
    actions,
    advancedTools(),
  );
}
