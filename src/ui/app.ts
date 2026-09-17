/**
 * Shell: header, progress rail, one step at a time, footer with "start over".
 */
import { NETWORK_LABEL } from "./format";
import { h, replace } from "./dom";
import type { Ports } from "./ports";
import { STEPS, freshState, wipe, type AppState, type StepId } from "./state";
import { renderStart } from "./steps/start";
import { renderSeed } from "./steps/seed";
import { renderScan } from "./steps/scan";
import { renderSweep } from "./steps/sweep";
import { renderResult } from "./steps/result";

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const SOURCE_URL = "https://github.com/Musqet/lnd-sweeper";

export interface Ctx {
  state: AppState;
  ports: Ports;
  go(step: StepId): void;
  startOver(): void;
  /** Re-render the current step (after state changes that affect the header). */
  refresh(): void;
}

export function mount(root: HTMLElement, ports: Ports, opts: { words?: readonly string[] } = {}): void {
  let state = freshState();
  // Development convenience (mock only): start with the seed words filled in.
  if (opts.words) for (let i = 0; i < state.words.length; i++) state.words[i] = opts.words[i] ?? "";

  const badge = h("span", { class: "badge", hidden: true });
  const footerReset = h("button", { type: "button", class: "linkish", onClick: () => ctx.startOver() }, "Start over and clear everything from memory");
  const rail = h("ol", { class: "rail", "aria-label": "Progress" });
  const main = h("main", { id: "step", tabindex: "-1" });
  const shell = h(
    "div",
    { class: "shell" },
    h(
      "header",
      { class: "top" },
      h("a", { class: "wordmark", href: SOURCE_URL, rel: "noopener", target: "_blank" }, "lnd-sweeper", h("small", {}, `v${APP_VERSION}`)),
      badge,
    ),
    rail,
    main,
    h(
      "footer",
      { class: "foot" },
      h("span", {}, "Free and open source, MIT licence. Runs entirely in this page."),
      footerReset,
    ),
  );

  const ctx: Ctx = {
    get state() {
      return state;
    },
    ports,
    go(step) {
      state.step = step;
      render();
    },
    startOver() {
      wipe(state);
      state = freshState();
      state.justCleared = true;
      render();
    },
    refresh() {
      render();
    },
  };

  function renderRail(): void {
    const idx = STEPS.findIndex((s) => s.id === state.step);
    replace(
      rail,
      ...STEPS.map((s, i) =>
        h(
          "li",
          { class: i < idx ? "done" : i === idx ? "current" : "", "aria-current": i === idx ? "step" : undefined },
          h("span", { class: "n", "aria-hidden": "true" }, i < idx ? "✓" : String(i + 1)),
          h("span", { class: "label" }, s.label),
          h("span", { class: "sr-only" }, i < idx ? " (done)" : i === idx ? " (current step)" : ""),
        ),
      ),
    );
  }

  function renderBadge(): void {
    if (state.step === "start") {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.className = `badge badge-${state.network}`;
    badge.textContent = NETWORK_LABEL[state.network];
  }

  function render(): void {
    renderRail();
    renderBadge();
    // The result step has its own, more prominent start-over button.
    footerReset.hidden = state.step === "result";
    const view =
      state.step === "start"
        ? renderStart(ctx)
        : state.step === "seed"
          ? renderSeed(ctx)
          : state.step === "scan"
            ? renderScan(ctx)
            : state.step === "sweep"
              ? renderSweep(ctx)
              : renderResult(ctx);
    replace(main, view);
    window.scrollTo({ top: 0 });
    // Move focus to the step heading so keyboard and screen reader users land in the right place.
    const heading = main.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }

  replace(root, shell);
  render();
}
