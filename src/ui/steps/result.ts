import type { Ctx } from "../app";
import { button, copyText, gloss, h, notice } from "../dom";
import { formatBtc, formatSats } from "../format";
import { feePercent, txUrl } from "../logic";

export function renderResult(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const signed = state.signed;
  const txid = state.broadcastTxid;
  if (!signed || !txid) {
    ctx.go("sweep");
    return h("div");
  }
  const total = signed.outputSats + signed.feeSats;
  const hex = h("textarea", { class: "mono", readonly: true, rows: "6", id: "signed-hex", "aria-label": "Signed transaction hex" }, signed.rawTxHex) as HTMLTextAreaElement;
  const copy = button("Copy", async () => {
    copy.textContent = (await copyText(signed.rawTxHex)) ? "Copied" : "Copy failed";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  }, { small: true });
  const link = txUrl(state.sourceUrl, txid);

  return h("section", {},
    h("h1", {}, "Transaction sent"),
    notice("ok",
      h("p", {}, h("strong", {}, `${formatBtc(signed.outputSats)} is on its way`), ` (${formatSats(signed.outputSats)}, after a fee of ${formatSats(signed.feeSats)}, ${feePercent(signed.feeSats, total)} of the total).`),
    ),
    h("dl", { class: "kv" },
      h("dt", {}, "Transaction ID"), h("dd", {}, h("a", { class: "addr", href: link, target: "_blank", rel: "noopener" }, txid)),
      h("dt", {}, "To"), h("dd", { class: "addr" }, signed.destination),
      h("dt", {}, "Size"), h("dd", {}, `${signed.vsize.toLocaleString("en-GB")} `, gloss("vB", "virtual bytes: the size the network charges for"), ` at ${signed.feeRateSatPerVb} sat/vB`),
    ),
    h("h2", {}, "What happens next"),
    h("ul", { class: "plain" },
      h("li", {}, "It should appear on the explorer within a minute. If the link shows nothing after a few minutes, broadcast the signed transaction below through another service."),
      h("li", {}, "The receiving wallet will show it as pending, then as confirmed once it is included in a block, usually within the time you chose with the fee rate."),
      h("li", {}, "Once it is confirmed, the old lnd wallet is empty. Keep the seed words somewhere safe until then, in case you need to sign again."),
      h("li", {}, "When you are done, press start over below to clear the seed from memory, then close this tab."),
    ),
    h("h2", {}, "Signed transaction"),
    h("p", { class: "small muted" }, "This is the raw signed transaction. It contains no secrets, and anyone can broadcast it for you: paste it into any block explorer's broadcast page, or run ", gloss("sendrawtransaction", "the Bitcoin Core command for submitting a signed transaction: bitcoin-cli sendrawtransaction <hex>"), " on your own node."),
    h("div", { class: "hexbox" }, h("div", { class: "hex-tools" }, h("label", { for: "signed-hex", class: "small muted" }, `${signed.rawTxHex.length / 2} bytes`), copy), hex),
    h("div", { class: "actions" }, button("Start over and clear everything from memory", () => ctx.startOver(), { primary: true })),
  );
}
