import "./ui/styles.css";
import { mount } from "./ui/app";
import type { Ports } from "./ui/ports";

const useMock = import.meta.env.DEV && new URLSearchParams(location.search).has("mock");

async function load(): Promise<{ ports: Ports; words?: readonly string[] }> {
  // Development only: `pnpm dev` then open /?mock to drive the whole flow with no
  // network, with the seed words pre-filled.
  if (useMock) {
    const mock = await import("./ui/mock");
    return { ports: mock.mockPorts, words: mock.SAMPLE_WORDS };
  }
  return { ports: (await import("./ui/adapters")).realPorts };
}

const root = document.getElementById("app");
if (root) {
  load().then(({ ports, words }) => mount(root, ports, words ? { words } : {}));
}
