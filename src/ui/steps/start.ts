import type { Network } from "../../types";
import { PUBLIC_SERVERS } from "../../chain";
import type { Ctx } from "../app";
import { button, field, gloss, h, notice, uid } from "../dom";
import { NETWORK_LABEL } from "../format";
import { DEFAULT_SOURCE, explorerSource, hasTrustedServers, isHttpUrl } from "../logic";

const NETWORKS: Network[] = ["mainnet", "signet", "testnet", "regtest"];

export function renderStart(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const groupName = uid("net");
  const srcName = uid("src");

  const source = h("input", { type: "url", class: "mono", value: state.sourceUrl, spellcheck: "false", autocomplete: "off", inputmode: "url" }) as HTMLInputElement;
  const sourceError = h("div", { class: "reason bad", role: "alert" });

  // Names the trusted servers for the chosen network, e.g. "mempool.space, blockstream.info and 2 more".
  const trustedNames = h("span", {});
  function refreshTrustedNames(): void {
    const list = PUBLIC_SERVERS[state.network];
    const names = list.map((s) => s.name);
    const shown = names.slice(0, 3).join(", ");
    trustedNames.textContent = names.length > 3 ? `${shown} and ${names.length - 3} more` : names.join(", ");
  }

  const customWrap = h("div", { class: "field", style: "margin-top:0.75rem" },
    field(
      "Your Esplora or mempool URL",
      source,
      h("span", {}, "Any mempool.space or ", gloss("Esplora", "the address-lookup API that mempool.space and many block explorers provide"), " API, including your own node's. Only this server is contacted. The browser-reachable equivalent of connecting your own Electrum server is to point this at your own mempool or Esplora instance."),
    ),
    sourceError,
  );

  const trustedInput = h("input", { type: "radio", name: srcName, value: "trusted", checked: state.useTrustedServers }) as HTMLInputElement;
  const ownInput = h("input", { type: "radio", name: srcName, value: "own", checked: !state.useTrustedServers }) as HTMLInputElement;

  function applyMode(): void {
    trustedInput.checked = state.useTrustedServers;
    ownInput.checked = !state.useTrustedServers;
    customWrap.hidden = state.useTrustedServers;
  }

  trustedInput.addEventListener("change", () => { state.useTrustedServers = true; applyMode(); });
  ownInput.addEventListener("change", () => { state.useTrustedServers = false; applyMode(); });

  const trustedToggle = h("div", { class: "field", hidden: !hasTrustedServers(state.network) },
    h("span", { class: "group-label" }, "Chain data source"),
    h("div", { class: "choices", role: "radiogroup", "aria-label": "Chain data source" },
      h("label", { class: "stacked" }, h("span", {}, trustedInput, " Trusted public servers ", h("span", { class: "hint inline" }, "(recommended)")), h("span", { class: "hint" }, h("span", {}, "Shares the scan out across ", trustedNames, " round-robin, so no single server is overloaded and recovery does not stall. Each server sees a fraction of your addresses; fee lookups and the broadcast go to all of them."))),
      h("label", { class: "stacked" }, h("span", {}, ownInput, " Your own server"), h("span", { class: "hint" }, "Use one server you choose, and only that one. Best for privacy and for lnd's full 2,500-address window.")),
    ),
  );

  const radios = NETWORKS.map((n) => {
    const input = h("input", { type: "radio", name: groupName, value: n, checked: state.network === n }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const previousDefault = DEFAULT_SOURCE[state.network];
      state.network = n;
      if (source.value.trim() === previousDefault || source.value.trim() === "") source.value = DEFAULT_SOURCE[n];
      // regtest has no public servers: force the custom URL.
      if (!hasTrustedServers(n)) state.useTrustedServers = false;
      trustedToggle.hidden = !hasTrustedServers(n);
      refreshTrustedNames();
      applyMode();
    });
    return h("label", {}, input, NETWORK_LABEL[n]);
  });

  const continueBtn = button("Continue to seed words", () => {
    if (!state.useTrustedServers) {
      const url = source.value.trim();
      if (!isHttpUrl(url)) {
        sourceError.textContent = "Enter a full URL starting with https:// or http://, for example https://mempool.space/api";
        source.classList.add("invalid");
        source.focus();
        return;
      }
      sourceError.textContent = "";
      state.sourceUrl = url.replace(/\/+$/, "");
    } else {
      // Explorer links use the first trusted server.
      state.sourceUrl = explorerSource(state.network, true, state.sourceUrl);
    }
    ctx.go("seed");
  }, { primary: true });

  refreshTrustedNames();
  applyMode();

  const form = h("form", { class: "starter", onSubmit: (e: Event) => { e.preventDefault(); continueBtn.click(); } },
    h("div", { class: "field" },
      h("span", { class: "group-label" }, "Network"),
      h("div", { class: "seg", role: "radiogroup", "aria-label": "Network" }, ...radios),
      h("div", { class: "hint" }, "Almost everyone wants Mainnet."),
    ),
    trustedToggle,
    customWrap,
    h("div", { class: "actions" }, continueBtn),
  );

  const cleared = state.justCleared
    ? notice("ok", h("p", {}, h("strong", {}, "Cleared."), " The seed words, passphrase, derived keys, scan results and any signed transaction were wiped from this page's memory. Nothing was ever written to disk."))
    : null;
  state.justCleared = false;

  return h(
    "section",
    {},
    h("h1", {}, "Recover on-chain funds from a dead LND node"),
    cleared,
    h("p", { class: "lede" }, "Type the 24 seed words lnd gave you. This page finds what is left on that wallet and sends all of it, in one transaction, to an address you choose."),
    notice(
      "warn",
      h("p", {}, h("strong", {}, "This only sweeps the wallet, not money in channels."), " If any channels are still open, restore the node with lnd and your channel backup, or use ", h("a", { href: "https://github.com/lightninglabs/chantools", rel: "noopener", target: "_blank" }, "chantools"), "."),
      h("p", {}, h("strong", {}, "Force-closed channels are not found here."), " After a force close, your share lands in a special output that lnd has to move into the wallet itself. If your node closed the channel, it is time-locked first, usually for between one day and two weeks. If the node was gone before lnd moved it, the money is still in that output and this page cannot see or spend it. Use chantools: ", h("code", {}, "sweepremoteclosed"), " if the other side closed the channel, ", h("code", {}, "sweeptimelockmanual"), " if your node closed it."),
    ),
    form,

    h("details", { class: "panel" },
      h("summary", {}, "Before you begin: run a verified copy"),
      h("div", { class: "body" },
        h("ul", { class: "plain", style: "margin-top:0.75rem" },
          h("li", {}, "Download this file from the release page and compare its ", gloss("SHA-256", "a fingerprint of the file; the release page shows the expected value and your operating system can compute yours"), " with the one published there. A tampered copy could send your funds elsewhere."),
          h("li", {}, "Open the downloaded file from disk rather than from a website. It contains no external scripts, images or fonts, and a content security policy blocks any that were added."),
          h("li", {}, "The only network requests it makes go to the chain data source you chose above. Nothing else leaves this page."),
          h("li", {}, "Your seed words and keys are held in memory only while this tab is open and are wiped when you press start over."),
        ),
      ),
    ),
    h("details", { class: "panel" },
      h("summary", {}, "Privacy: what the data source learns"),
      h("div", { class: "body" },
        h("p", { class: "small", style: "margin-top:0.75rem" }, "To find your coins the page asks the data source about every address the wallet could have used: a few hundred for the quick scan, up to about 17,500 for lnd's full window. That server therefore learns which addresses belong together, their balances, your IP address, and the transaction you broadcast. Public servers also rate-limit heavy use, which is why the trusted-servers option shares a scan out across several of them in round-robin, so each takes a fraction of the load and a big scan still finishes; a server that asks us to slow down is rested until it recovers."),
        h("p", { class: "small" }, "Trade-off: with the trusted servers, your addresses are shared out across several servers so each sees only a fraction, and fee lookups and the final broadcast go to all of them. With your own server, one server you control sees everything and nothing leaks elsewhere. For the strongest privacy, run your own mempool or Esplora instance, or open this page in a browser that routes through Tor."),
      ),
    ),
    h("details", { class: "panel" },
      h("summary", {}, "What this page does and does not do"),
      h("div", { class: "body" },
        h("ul", { class: "plain", style: "margin-top:0.75rem" },
          h("li", {}, "It reproduces lnd's wallet recovery: it deciphers the aezeed seed, derives the same addresses lnd would, and checks them in order, stopping after 100 unused ones in a row on each path (or 2,500 if you scan deeper, lnd's own recovery window)."),
          h("li", {}, "It builds and signs one transaction in your browser and hands it to the data source to broadcast. You can also broadcast the signed transaction yourself."),
          h("li", {}, "It does not recover channel funds, does not read channel backups, and never sends your seed anywhere."),
        ),
      ),
    ),
  );
}
