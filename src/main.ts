import "./ui/styles.css";
import { mount } from "./ui/app";
import type { Ports } from "./ui/ports";

async function loadPorts(): Promise<Ports> {
  // Development only: `pnpm dev` then open /?mock to drive the whole flow with no network.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    return (await import("./ui/mock")).mockPorts;
  }
  return (await import("./ui/adapters")).realPorts;
}

const root = document.getElementById("app");
if (root) {
  loadPorts().then((ports) => mount(root, ports));
}
