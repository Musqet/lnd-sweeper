/** Tiny DOM helpers. No framework. */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | ((e: Event) => void) | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      el.className = String(v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, ...children);
}

/** Inline error/notice block, or nothing when message is empty. */
export function notice(kind: "error" | "warn" | "info" | "ok", ...children: Child[]): HTMLElement {
  return h("div", { class: `notice notice-${kind}`, role: kind === "error" ? "alert" : "status" }, ...children);
}

export function spinner(text: string): HTMLElement {
  return h("div", { class: "spinner", role: "status", "aria-live": "polite" }, h("span", { class: "spinner-dot", "aria-hidden": "true" }), h("span", {}, text));
}

let idCounter = 0;
export function uid(prefix = "f"): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

export function field(label: string, input: HTMLElement, hint?: Child): HTMLElement {
  if (!input.id) input.id = uid();
  const wrap = h("div", { class: "field" }, h("label", { for: input.id }, label), input);
  if (hint) {
    const hintEl = h("div", { class: "hint", id: uid("hint") }, hint);
    input.setAttribute("aria-describedby", hintEl.id);
    wrap.appendChild(hintEl);
  }
  return wrap;
}

export function button(label: string, onClick: () => void, opts: { primary?: boolean; danger?: boolean; small?: boolean; type?: "button" | "submit" } = {}): HTMLButtonElement {
  const cls = ["btn", opts.primary && "btn-primary", opts.danger && "btn-danger", opts.small && "btn-small"].filter(Boolean).join(" ");
  return h("button", { type: opts.type ?? "button", class: cls, onClick: () => onClick() }, label);
}

/** Copy to clipboard with a fallback for non-secure contexts (file://). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** A term followed by a small "?" that toggles a plain-words explanation inline. */
export function gloss(term: string, explanation: string): HTMLElement {
  const text = h("span", { class: "gloss-text", hidden: true }, explanation);
  const btn = h("button", { type: "button", class: "gloss-btn", "aria-expanded": "false", "aria-label": `What is ${term}?`, onClick: () => {
    const open = text.hidden;
    text.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  } }, "?");
  return h("span", { class: "gloss" }, term, btn, text);
}
