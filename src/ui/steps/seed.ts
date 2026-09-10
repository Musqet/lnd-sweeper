import type { Ctx } from "../app";
import { button, gloss, h, notice, replace, spinner } from "../dom";
import { birthdayDate, errorText } from "../format";
import { WORD_COUNT, distributeWords } from "../logic";
import { UiError } from "../ports";

export function renderSeed(ctx: Ctx): HTMLElement {
  const { state, ports } = ctx;
  const inputs: HTMLInputElement[] = [];
  const suggBoxes: HTMLElement[] = [];
  const count = h("div", { class: "count", "aria-live": "polite" });
  const reason = h("span", { class: "reason", "aria-live": "polite" });
  const status = h("div", {});
  const decipherBtn = button("Decipher seed", () => void decipher(), { primary: true });
  const continueBtn = button("Continue to scan", () => ctx.go("scan"), { primary: true });
  let busy = false;

  function invalidateSeed(): void {
    if (state.seed) {
      state.seed.entropy.fill(0);
      state.seed = null;
      state.scan = null;
      replace(status);
      decipherBtn.hidden = false;
    }
  }

  /** Validate one box. `final` means the user has left it, so an incomplete word is a problem. */
  function check(i: number, final: boolean): boolean {
    const input = inputs[i]!;
    const box = suggBoxes[i]!;
    const word = input.value.trim().toLowerCase();
    input.classList.remove("valid", "invalid");
    replace(box);
    input.removeAttribute("aria-invalid");
    if (word === "") return false;
    const res = ports.checkWord(word);
    if (res.valid) {
      input.classList.add("valid");
      return true;
    }
    const hasPrefix = res.suggestions.some((s) => s.startsWith(word));
    if (!final && hasPrefix) {
      for (const s of res.suggestions.slice(0, 3)) box.appendChild(suggestion(i, s));
      return false;
    }
    input.classList.add("invalid");
    input.setAttribute("aria-invalid", "true");
    if (res.suggestions.length === 0) {
      box.appendChild(h("span", { class: "none" }, "not in the word list"));
    } else {
      box.appendChild(h("span", { class: "sr-only" }, "Not in the word list. Did you mean: "));
      for (const s of res.suggestions) box.appendChild(suggestion(i, s));
    }
    return false;
  }

  function suggestion(i: number, word: string): HTMLElement {
    return h("button", { type: "button", "aria-label": `Use ${word}`, onClick: () => {
      inputs[i]!.value = word;
      state.words[i] = word;
      check(i, true);
      updateCount();
      focusBox(i + 1);
    } }, word);
  }

  function focusBox(i: number): void {
    const target = inputs[Math.min(i, WORD_COUNT - 1)]!;
    target.focus();
    target.select();
  }

  /** Index of the first box that blocks deciphering: a wrong word first, then the first empty one. */
  function firstProblem(): { index: number; kind: "invalid" | "empty" } | null {
    for (let i = 0; i < WORD_COUNT; i++) {
      const w = state.words[i]?.trim() ?? "";
      if (w !== "" && !ports.checkWord(w).valid) return { index: i, kind: "invalid" };
    }
    for (let i = 0; i < WORD_COUNT; i++) if ((state.words[i]?.trim() ?? "") === "") return { index: i, kind: "empty" };
    return null;
  }

  function updateCount(): void {
    const valid = state.words.filter((w) => w.trim() !== "" && ports.checkWord(w).valid).length;
    const problem = firstProblem();
    const ok = problem === null;
    count.textContent = ok ? `${WORD_COUNT} of ${WORD_COUNT} words, all recognised` : `${valid} of ${WORD_COUNT} words`;
    count.classList.toggle("ok", ok);
    decipherBtn.disabled = !ok || busy;
    if (ok || busy) {
      reason.textContent = "";
      reason.classList.remove("bad");
    } else if (problem.kind === "invalid") {
      reason.textContent = `Word ${problem.index + 1} is not in the word list.`;
      reason.classList.add("bad");
    } else {
      const missing = WORD_COUNT - valid;
      reason.textContent = `${missing} more word${missing === 1 ? "" : "s"} needed.`;
      reason.classList.remove("bad");
    }
  }

  /** Enter or a submit while blocked: take the user to the box that needs attention. */
  function goToProblem(): void {
    const p = firstProblem();
    if (!p) return;
    const el = inputs[p.index]!;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
    if (p.kind === "invalid") check(p.index, true);
  }

  for (let i = 0; i < WORD_COUNT; i++) {
    const id = `word-${i + 1}`;
    const input = h("input", {
      type: "text", id, autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false",
      inputmode: "text", value: state.words[i] ?? "", "aria-label": `Word ${i + 1}`,
    }) as HTMLInputElement;
    const box = h("div", { class: "sugg" });
    inputs.push(input);
    suggBoxes.push(box);

    input.addEventListener("input", () => {
      invalidateSeed();
      const v = input.value.toLowerCase();
      if (v !== input.value) input.value = v;
      state.words[i] = v.trim();
      check(i, false);
      updateCount();
    });
    input.addEventListener("blur", () => {
      input.value = input.value.trim();
      state.words[i] = input.value;
      check(i, true);
      updateCount();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (input.value.trim() === "") return;
        if (e.key === "Enter" && i === WORD_COUNT - 1) {
          if (decipherBtn.disabled) goToProblem();
          else decipherBtn.click();
        } else {
          focusBox(i + 1);
        }
      } else if (e.key === "Backspace" && input.value === "" && i > 0) {
        e.preventDefault();
        focusBox(i - 1);
      }
    });
    input.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (text.trim().split(/\s+/).length < 2) return; // single word: let the browser paste it
      e.preventDefault();
      invalidateSeed();
      const { words, focus } = distributeWords(state.words, text, i);
      for (let j = 0; j < WORD_COUNT; j++) {
        state.words[j] = words[j]!;
        inputs[j]!.value = words[j]!;
        check(j, words[j] !== "");
      }
      updateCount();
      focusBox(focus);
    });
  }

  const canMask = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-text-security", "disc");
  let wordsHidden = false;
  const hideWords = h("button", { type: "button", class: "btn btn-small", "aria-pressed": "false", onClick: () => {
    wordsHidden = !wordsHidden;
    for (const el of inputs) {
      if (canMask) el.classList.toggle("masked", wordsHidden);
      else el.type = wordsHidden ? "password" : "text";
    }
    hideWords.textContent = wordsHidden ? "Show words" : "Hide words";
    hideWords.setAttribute("aria-pressed", String(wordsHidden));
  } }, "Hide words");

  const grid = h("div", { class: "words" },
    ...inputs.map((input, i) => h("div", { class: "word" }, h("label", { for: input.id, "aria-hidden": "true" }, String(i + 1)), input, suggBoxes[i]!)),
  );

  // A text input, masked with CSS where the browser supports it, so no browser offers to save it as a password.
  // Where masking is unsupported the field starts visible and says so.
  const pass = h("input", { type: "text", id: "cipher-pass", class: canMask ? "masked" : "", autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false", "data-1p-ignore": "", "data-lpignore": "true", value: state.passphrase, "aria-describedby": "pass-hint" }) as HTMLInputElement;
  pass.addEventListener("input", () => { state.passphrase = pass.value; invalidateSeed(); });
  const showPass = h("button", { type: "button", class: "btn btn-small", "aria-pressed": String(!canMask), onClick: () => {
    const show = pass.classList.contains("masked");
    pass.classList.toggle("masked", !show);
    showPass.textContent = show ? "Hide" : "Show";
    showPass.setAttribute("aria-pressed", String(show));
  } }, canMask ? "Show" : "Hide");
  if (!canMask) showPass.hidden = true;
  const passNote = canMask ? null : h("div", { class: "hint" }, "Shown as you type: this browser cannot mask the field without treating it as a password.");

  async function decipher(): Promise<void> {
    if (busy) return;
    busy = true;
    decipherBtn.disabled = true;
    inputs.forEach((el) => (el.disabled = true));
    pass.disabled = true;
    replace(status, spinner("Deciphering your seed. This runs scrypt, a deliberately slow step lnd built in to protect the seed, so it takes a few seconds and the page may feel busy."));
    try {
      const seed = await ports.decipher(state.words.map((w) => w.trim().toLowerCase()), state.passphrase);
      state.seed = seed;
      decipherBtn.hidden = true;
      replace(status,
        notice("ok",
          h("p", {}, h("strong", {}, "Seed deciphered.")),
          h("p", {}, `This wallet was created on or around ${birthdayDate(seed.birthdayDays)}. `, "That date is the seed's ", gloss("birthday", "lnd stamps the creation date into the seed so a restore knows how far back to look"), ". If it does not match when you set the node up, check the words before going on."),
        ),
        h("div", { class: "actions" }, continueBtn),
      );
      continueBtn.focus();
    } catch (e) {
      const code = e instanceof UiError ? e.code : "other";
      const detail = e instanceof UiError && e.detail && e.detail !== e.message ? e.detail : undefined;
      replace(status,
        notice("error",
          h("p", {}, h("strong", {}, code === "passphrase" ? "The passphrase does not match this seed." : code === "checksum" ? "These words did not decipher." : "Could not decipher the seed.")),
          h("p", {}, code === "passphrase"
            ? "If you never set a cipher seed passphrase, leave the field empty. This is not the password you used to unlock the wallet. If you did set one, check it for typing mistakes and case."
            : code === "checksum"
              ? "Usually one word is wrong or two are swapped. Check each word against what you wrote down. If you set a cipher seed passphrase when the wallet was created, enter it below and try again."
              : errorText(e)),
          detail ? h("p", { class: "small muted mono" }, detail) : (code === "passphrase" || code === "checksum") ? h("p", { class: "small muted mono" }, errorText(e)) : null,
        ),
      );
      status.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } finally {
      busy = false;
      inputs.forEach((el) => (el.disabled = false));
      pass.disabled = false;
      updateCount();
    }
  }

  updateCount();
  if (state.seed) {
    decipherBtn.hidden = true;
    replace(status,
      notice("ok", h("p", {}, `Seed deciphered. Wallet created on or around ${birthdayDate(state.seed.birthdayDays)}.`)),
      h("div", { class: "actions" }, continueBtn),
    );
  }
  for (let i = 0; i < WORD_COUNT; i++) if (state.words[i]) check(i, true);

  queueMicrotask(() => { if (!state.words[0]) inputs[0]!.focus(); });

  return h("section", {},
    h("h1", {}, "Enter your 24 seed words"),
    h("p", { class: "lede" }, "These are the words lnd showed you when you first created the wallet. Type them in order, or paste the whole phrase into any box and it will be spread across all 24."),
    h("form", { onSubmit: (e: Event) => { e.preventDefault(); if (decipherBtn.disabled) goToProblem(); else decipherBtn.click(); } },
      h("div", { class: "inline", style: "justify-content: space-between" }, h("span", { class: "group-label", style: "margin:0" }, "Seed words"), h("span", { class: "inline" }, count, hideWords)),
      grid,
      h("h2", {}, "Cipher seed passphrase (rarely set)"),
      h("p", { class: "small", id: "pass-hint" }, h("strong", {}, "This is not your wallet unlock password."), " It is an extra passphrase some people typed when the seed was first generated, before the words were shown. Most people never set one. Leave this empty unless you did."),
      h("div", { class: "field" }, h("label", { for: "cipher-pass" }, "Passphrase, usually empty"), h("div", { class: "inline" }, pass, showPass), passNote),
      h("div", { class: "actions" }, decipherBtn, reason, h("span", { class: "spacer" }), button("Back", () => ctx.go("start"))),
    ),
    status,
  );
}
