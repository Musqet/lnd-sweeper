/**
 * Curated public Esplora HTTP endpoints, one small trusted set per network.
 *
 * These are the servers the tool spreads a scan across by default so that a
 * single server's rate limit does not stall recovery for someone who has no
 * node of their own. Every entry was checked to:
 *   - serve the Esplora REST API this tool speaks (mempool.space is
 *     Esplora-compatible; Blockstream's electrs *is* Esplora),
 *   - expose the full surface we use: /blocks/tip/height, /fee-estimates,
 *     /address/:a, /address/:a/txs, /address/:a/utxo, POST /tx,
 *   - send permissive CORS (Access-Control-Allow-Origin: *) so a browser can
 *     reach it from this static page,
 *   - serve the network it is listed under.
 *
 * We do NOT include Electrum servers (Sparrow's list): the Electrum protocol is
 * raw TCP/SSL and a browser cannot open those sockets. The browser-reachable
 * equivalent of "connect to your own Electrum" is to point the tool at your own
 * mempool.space or Esplora (electrs) instance via the custom-URL field.
 *
 * Ordering: the trusted-servers path round-robins across every healthy entry,
 * so position does not decide how much load a server takes. It still matters in
 * two narrower ways: the "failover" strategy prefers the earliest-listed server,
 * and the UI builds its explorer links from the first entry. Put the most
 * reliable / highest-limit server first.
 */
import type { Network } from "../types";

export interface EsploraServer {
  /** Short host-style label shown in the UI. */
  readonly name: string;
  /** Base URL including the "/api" (or "/<net>/api") suffix, no trailing slash needed. */
  readonly url: string;
}

/**
 * Verified 2026-09-10. Blockstream serves testnet3, a different chain from the
 * testnet4 this tool defaults to, so it is deliberately absent from testnet.
 * regtest is local-only: there are no public servers, only the custom URL.
 */
export const PUBLIC_SERVERS: Readonly<Record<Network, readonly EsploraServer[]>> = {
  mainnet: [
    { name: "mempool.space", url: "https://mempool.space/api" },
    { name: "blockstream.info", url: "https://blockstream.info/api" },
    { name: "mempool.emzy.de", url: "https://mempool.emzy.de/api" },
    { name: "mempool.bitaroo.net", url: "https://mempool.bitaroo.net/api" },
  ],
  signet: [
    { name: "mempool.space", url: "https://mempool.space/signet/api" },
    { name: "blockstream.info", url: "https://blockstream.info/signet/api" },
  ],
  testnet: [{ name: "mempool.space", url: "https://mempool.space/testnet4/api" }],
  regtest: [],
};

/** The trusted public server URLs for a network, in preference order (may be empty). */
export function publicServerUrls(network: Network): string[] {
  return PUBLIC_SERVERS[network].map((s) => s.url);
}

/** Short host label for a base URL, for status lines ("mempool.space is busy; using blockstream.info"). */
export function serverLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
