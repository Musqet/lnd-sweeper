import type { OwnedUtxo, SweepPlan } from "../../types";
import type { Ctx } from "../app";
import { button, copyText, field, gloss, h, notice, replace, spinner } from "../dom";
import { NETWORK_LABEL, errorText, formatBtc, formatSats, formatSatsInText } from "../format";
import { CONFIRM_CHARS, confirmGate, confirmSlice, feePercent, pickFee } from "../logic";
import { UiError } from "../ports";

type Speed = "fast" | "medium" | "slow";

export function renderSweep(ctx: Ctx): HTMLElement {
  const { state, ports } = ctx;
  if (!state.scan || !state.seed || !state.client || state.scan.totalSats === 0) {
    ctx.go("scan");
    return h("div");
  }
  const scan = state.scan;
  const seed = state.seed;
  const client = state.client;

  // Inputs: unconfirmed outputs only when the user ticked the box on the scan step.
  const inputs: OwnedUtxo[] = state.includeUnconfirmed ? scan.utxos : scan.utxos.filter((u) => u.status.confirmed);
  const excluded = scan.utxos.length - inputs.length;
  const total = inputs.reduce((a, u) => a + u.value, 0);
  if (total <= 0) {
    ctx.go("scan");
    return h("div");
  }

  // Destination
  const dest = h("input", { type: "text", class: "mono", autocomplete: "off", autocapitalize: "none", spellcheck: "false", value: state.plan?.destination ?? state.destination, placeholder: state.network === "mainnet" ? "bc1q…" : "" }) as HTMLInputElement;
  const destMsg = h("div", { class: "hint", "aria-live": "polite" });
  let destOk = false;

  // Fee
  const feeInput = h("input", { type: "number", min: "1", step: "0.1", inputmode: "decimal", value: state.plan ? String(state.plan.feeRateSatPerVb) : "", style: "max-width:9rem" }) as HTMLInputElement;
  const feeButtons = new Map<Speed, HTMLButtonElement>();
  const feeNote = h("div", { class: "hint", "aria-live": "polite" });
  const speeds: { id: Speed; label: string; desc: string }[] = [
    { id: "fast", label: "Fast", desc: "next block or two" },
    { id: "medium", label: "Medium", desc: "within about an hour" },
    { id: "slow", label: "Slow", desc: "within a day" },
  ];
  const feesRow = h("div", { class: "fees", role: "group", "aria-label": "Fee rate presets" },
    ...speeds.map((s) => {
      const b = h("button", { type: "button", class: "fee", "aria-pressed": "false", onClick: () => {
        const v = state.feeEstimates ? pickFee(state.feeEstimates, s.id) : undefined;
        if (v === undefined) return;
        feeInput.value = String(v);
        setPressed(s.id);
        update();
      } }, h("span", { class: "t" }, s.label), h("span", { class: "v" }, "…"), h("span", { class: "v" }, s.desc)) as HTMLButtonElement;
      b.disabled = true;
      feeButtons.set(s.id, b);
      return b;
    }),
  );
  function setPressed(which: Speed | null): void {
    for (const [id, b] of feeButtons) b.setAttribute("aria-pressed", String(id === which));
  }
  function fillFeeButtons(): void {
    for (const s of speeds) {
      const b = feeButtons.get(s.id)!;
      const v = state.feeEstimates ? pickFee(state.feeEstimates, s.id) : undefined;
      b.querySelectorAll(".v")[0]!.textContent = v === undefined ? "unavailable" : `${v} sat/vB`;
      b.disabled = v === undefined;
    }
  }

  // Preview
  const preview = h("div", {});
  const reviewBtn = button("Review transaction", () => review(), { primary: true });
  reviewBtn.disabled = true;
  const reviewReason = h("span", { class: "reason", "aria-live": "polite" });
  let plan: SweepPlan | null = null;
  let tipHeight: number | undefined;
  let allowHighFee = false;

  function checkDest(): void {
    const v = dest.value.trim();
    dest.classList.remove("valid", "invalid");
    dest.removeAttribute("aria-invalid");
    destMsg.style.color = "";
    destOk = false;
    if (v === "") {
      destMsg.textContent = "Paste the receiving address from the wallet the funds should go to. Make sure it came from a wallet you control.";
      return;
    }
    const res = ports.validateDestination(v, state.network);
    if (res.ok) {
      destOk = true;
      dest.classList.add("valid");
      destMsg.textContent = `${res.kind} on ${NETWORK_LABEL[res.network]}.`;
    } else {
      dest.classList.add("invalid");
      dest.setAttribute("aria-invalid", "true");
      destMsg.textContent = res.reason;
      destMsg.style.color = "var(--danger)";
    }
  }

  function feeRate(): number | null {
    const v = Number(feeInput.value);
    if (!Number.isFinite(v) || v < 1) return null;
    return Math.round(v * 10) / 10;
  }

  function feeLine(p: SweepPlan): HTMLElement {
    return h("span", {}, `${formatSats(p.feeSats)}, ${feePercent(p.feeSats, total)} of the total, at ${p.feeRateSatPerVb} sat/vB`);
  }

  function update(): void {
    checkDest();
    plan = null;
    const rate = feeRate();
    if (feeInput.value !== "" && rate === null) {
      feeNote.textContent = "Fee rate must be a number of at least 1 sat/vB.";
      feeNote.style.color = "var(--danger)";
    } else {
      feeNote.textContent = rate !== null && rate > 500 ? "That is a very high fee rate. Check it is what you meant." : "";
      feeNote.style.color = rate !== null && rate > 500 ? "var(--warn)" : "";
    }
    if (!destOk || rate === null) {
      replace(preview);
      reviewBtn.disabled = true;
      reviewReason.textContent = !destOk && rate === null ? "Enter a destination address and a fee rate." : !destOk ? (dest.value.trim() ? "Fix the destination address first." : "Enter a destination address first.") : "Enter a fee rate first.";
      return;
    }
    try {
      // Always a fresh plan from the module; never edit a plan after it was made.
      plan = ports.planSweep(inputs, dest.value.trim(), rate, state.network, { tipHeight, allowHighFee, allowUnconfirmed: state.includeUnconfirmed });
      replace(preview,
        h("dl", { class: "kv" },
          h("dt", {}, "Inputs"), h("dd", {}, `${plan.inputs.length} unspent output${plan.inputs.length === 1 ? "" : "s"}, ${formatSats(total)}`),
          h("dt", {}, "Estimated size"), h("dd", {}, `${plan.estimatedVsize.toLocaleString("en-GB")} `, gloss("vB", "virtual bytes: the size the network charges for; fees are paid per virtual byte")),
          h("dt", {}, "Fee"), h("dd", {}, feeLine(plan)),
          h("dt", {}, "You receive"), h("dd", {}, h("strong", {}, formatBtc(plan.outputSats)), ` (${formatSats(plan.outputSats)})`),
        ),
      );
      reviewBtn.disabled = false;
      reviewReason.textContent = "";
    } catch (e) {
      const highFee = e instanceof UiError && e.code === "fee-too-large";
      reviewReason.textContent = highFee ? "Accept the fee above, or lower it." : "Fix the fee rate first.";
      const accept = h("input", { type: "checkbox", id: "allow-high-fee" }) as HTMLInputElement;
      accept.addEventListener("change", () => { allowHighFee = accept.checked; update(); });
      replace(preview,
        notice(highFee ? "warn" : "error",
          h("p", {}, formatSatsInText(errorText(e))),
          highFee ? h("div", { class: "check" }, accept, h("label", { for: "allow-high-fee" }, "I understand and accept this fee")) : null,
        ),
      );
      reviewBtn.disabled = true;
    }
  }

  dest.addEventListener("input", () => {
    // Addresses never contain whitespace; pasted line breaks and spaces are dropped rather than rejected.
    const cleaned = dest.value.replace(/\s+/g, "");
    if (cleaned !== dest.value) dest.value = cleaned;
    state.destination = cleaned;
    update();
  });
  feeInput.addEventListener("input", () => { setPressed(null); update(); });

  const formSection = h("div", {});
  const confirmSection = h("div", {});

  function review(): void {
    if (!plan) return;
    const p = plan;
    state.plan = p;
    formSection.hidden = true;
    const { head, tail } = confirmSlice(p.destination);
    const gateInput = h("input", { type: "text", class: "mono", autocomplete: "off", autocapitalize: "none", spellcheck: "false", maxlength: String(CONFIRM_CHARS), style: "max-width:10rem", "aria-describedby": "gate-hint" }) as HTMLInputElement;
    const gateMsg = h("div", { class: "hint", id: "gate-hint" }, `Type the last ${CONFIRM_CHARS} characters of the address, highlighted above, to confirm you have checked it against your wallet.`);
    const gateState = h("div", { class: "reason", "aria-live": "polite" });
    const sendBtn = button("Sign and broadcast", () => void send(p), { primary: true });
    sendBtn.disabled = true;
    gateInput.addEventListener("input", () => {
      const g = confirmGate(p.destination, gateInput.value);
      sendBtn.disabled = !g.ok;
      gateInput.classList.toggle("valid", g.ok);
      gateInput.classList.toggle("invalid", g.mismatch);
      gateInput.setAttribute("aria-invalid", String(g.mismatch));
      gateState.textContent = g.mismatch ? `Does not match the last ${CONFIRM_CHARS} characters of the address.` : g.ok ? "Matches." : "";
      gateState.classList.toggle("bad", g.mismatch);
    });
    const unconfirmed = p.inputs.filter((u) => !u.status.confirmed).length;
    const sendStatus = h("div", {});
    replace(confirmSection,
      h("div", { class: "confirm" },
        h("h2", {}, "Check before you send"),
        h("p", {}, "This cannot be undone. Everything selected on the old wallet will be sent in one transaction to:"),
        h("p", { class: "addr" }, h("strong", {}, head, h("mark", { class: "tail" }, tail))),
        h("dl", { class: "kv" },
          h("dt", {}, "Amount you receive"), h("dd", {}, h("strong", {}, formatBtc(p.outputSats)), ` (${formatSats(p.outputSats)})`),
          h("dt", {}, "Fee"), h("dd", {}, feeLine(p)),
          h("dt", {}, "Inputs"), h("dd", {}, `${p.inputs.length} unspent output${p.inputs.length === 1 ? "" : "s"}${unconfirmed ? `, ${unconfirmed} unconfirmed (you accepted this)` : ""}`),
          h("dt", {}, "Network"), h("dd", {}, NETWORK_LABEL[state.network]),
        ),
        h("div", { class: "field" }, h("label", { for: (gateInput.id = "gate") }, `Last ${CONFIRM_CHARS} characters of the destination`), gateInput, gateMsg, gateState),
        h("div", { class: "actions" }, sendBtn, h("span", { class: "spacer" }), button("Back to edit", () => { formSection.hidden = false; replace(confirmSection); dest.focus(); })),
        sendStatus,
      ),
    );
    gateInput.focus();

    async function send(p: SweepPlan): Promise<void> {
      sendBtn.disabled = true;
      gateInput.disabled = true;
      replace(sendStatus, spinner("Signing the transaction in this page."));
      let signed;
      try {
        signed = await ports.signSweep(p, seed, state.network);
        state.signed = signed;
      } catch (e) {
        const tampered = e instanceof UiError && e.code === "plan-tampered";
        replace(sendStatus,
          notice("error", h("p", {}, h("strong", {}, "Signing failed. Nothing was sent.")), h("p", {}, formatSatsInText(errorText(e)))),
          tampered ? h("div", { class: "actions" }, button("Back and prepare again", () => { formSection.hidden = false; replace(confirmSection); update(); }, { primary: true })) : null,
        );
        if (!tampered) {
          sendBtn.disabled = false;
          gateInput.disabled = false;
        }
        return;
      }
      replace(sendStatus, spinner(`Broadcasting to ${new URL(state.sourceUrl).host}.`));
      try {
        state.broadcastTxid = await client.broadcast(signed.rawTxHex);
        ctx.go("result");
      } catch (e) {
        const hex = h("textarea", { class: "mono", readonly: true, rows: "5", id: "signed-hex", "aria-label": "Signed transaction hex" }, signed.rawTxHex) as HTMLTextAreaElement;
        const copy = button("Copy", async () => { copy.textContent = (await copyText(signed.rawTxHex)) ? "Copied" : "Copy failed"; setTimeout(() => (copy.textContent = "Copy"), 1500); }, { small: true });
        replace(sendStatus,
          notice("error",
            h("p", {}, h("strong", {}, "The transaction was signed but the data source refused to broadcast it.")),
            h("p", {}, "Nothing has been spent. The server said:"),
            h("p", { class: "small mono" }, errorText(e)),
            e instanceof UiError && e.detail && e.detail !== e.message ? h("p", { class: "small mono muted" }, e.detail) : null,
            h("p", {}, "If the message mentions the fee, go back and raise the fee rate. If it mentions an input being missing or spent, scan again. You can also broadcast the signed transaction below yourself, for example through a block explorer's broadcast page."),
          ),
          h("div", { class: "hexbox" }, h("div", { class: "hex-tools" }, h("label", { for: "signed-hex", class: "small muted" }, "Signed transaction"), copy), hex),
          h("div", { class: "actions" }, button("Try broadcasting again", () => void send(p), { primary: true }), button("Back to edit", () => { formSection.hidden = false; replace(confirmSection); })),
        );
      }
    }
  }

  /** Every entry to this step ends with a preset selected and a plan previewed, whether estimates were cached or fetched. */
  function applyDefaultFee(): void {
    fillFeeButtons();
    if (!state.feeEstimates) return;
    if (feeInput.value === "") {
      const v = pickFee(state.feeEstimates, "medium");
      if (v !== undefined) { feeInput.value = String(v); setPressed("medium"); }
    } else {
      const current = feeRate();
      const match = speeds.find((sp) => pickFee(state.feeEstimates!, sp.id) === current);
      setPressed(match ? match.id : null);
    }
    update();
  }

  async function loadFees(): Promise<void> {
    client.getTipHeight().then((t) => { tipHeight = t; if (plan) update(); }, () => { /* nLockTime is optional; planSweep copes without it */ });
    if (state.feeEstimates) {
      applyDefaultFee();
      return;
    }
    feeNote.textContent = "Fetching current fee rates…";
    try {
      state.feeEstimates = await client.getFeeEstimates();
      feeNote.textContent = "";
      applyDefaultFee();
    } catch (e) {
      fillFeeButtons();
      feeNote.textContent = `Could not fetch fee estimates (${errorText(e)}). Enter a rate yourself; mempool.space shows current rates.`;
      feeNote.style.color = "var(--warn)";
    }
  }

  replace(formSection,
    field("Destination address", dest, undefined),
    destMsg,
    h("div", { class: "field", style: "margin-top:1.25rem" },
      h("span", { class: "group-label" }, "Fee rate, in ", gloss("sat/vB", "satoshis per virtual byte: the price you pay for block space; a higher rate is confirmed sooner")),
      feesRow,
      h("div", { class: "inline" }, h("label", { for: (feeInput.id = "feerate") }, "Custom"), feeInput, h("span", { class: "muted" }, "sat/vB")),
      feeNote,
    ),
    h("h2", {}, "Preview"),
    preview,
    h("div", { class: "actions" }, reviewBtn, reviewReason, h("span", { class: "spacer" }), button("Back", () => ctx.go("scan"))),
  );

  update();
  void loadFees();
  queueMicrotask(() => { if (!dest.value) dest.focus(); });

  return h("section", {},
    h("h1", {}, "Send the funds to a wallet you control"),
    h("p", { class: "lede" }, `${formatSats(total)} will go to one address in a single transaction, minus the mining fee.`, excluded > 0 ? ` ${excluded} unconfirmed output${excluded === 1 ? " is" : "s are"} left out, as you chose on the previous step.` : ""),
    formSection,
    confirmSection,
  );
}
