#!/usr/bin/env bash
# Start a regtest bitcoind + lnd + Esplora shim with funded lnd addresses for manual UI testing.
# Prints the 24 words, the shim URL and lnd's balance. Stop with scripts/e2e-down.sh or Ctrl-C.
#
#   E2E_MNEMONIC="word1 ... word24" E2E_PASSPHRASE=... scripts/e2e-up.sh   restore a known seed into lnd
#   E2E_KILL_LND=1 scripts/e2e-up.sh                                         kill and wipe lnd after funding
#   LND_BIN / LNCLI_BIN / BITCOIND_BIN / CHANTOOLS_BIN                        override binaries
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .e2e-data/state.json ]; then
  echo "scripts/e2e-up.sh: .e2e-data/state.json exists; run scripts/e2e-down.sh first" >&2
  exit 1
fi

# The harness is TypeScript with extensionless imports; Vite's module runner executes it without a build step.
exec node --input-type=module -e '
import { runnerImport } from "vite";
const { module } = await runnerImport(process.cwd() + "/test/e2e/harness/up.ts", { configFile: false, logLevel: "error" });
await module.main();
'
