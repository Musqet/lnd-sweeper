import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import pkg from "./package.json" with { type: "json" };

const OUT_NAME = "lnd-sweeper.html";

/**
 * Fixed output name. vite-plugin-singlefile inlines everything into index.html
 * and deletes the inlined chunks. We run after it and re-emit that one file as
 * lnd-sweeper.html, dropping anything else, so the release artefact is exactly
 * one file with a stable name.
 */
function fixedOutputName(): Plugin {
  return {
    name: "lnd-sweeper:fixed-output-name",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (!html || html.type !== "asset") {
        this.error("expected a single index.html asset in the bundle");
      }
      for (const key of Object.keys(bundle)) delete bundle[key];
      this.emitFile({ type: "asset", fileName: OUT_NAME, source: html.source });
    },
  };
}

/**
 * Refuse to build anything but a production bundle. `NODE_ENV=development vite build`
 * keeps `import.meta.env.DEV` true, which inlines the dev-only mock (src/ui/mock.ts)
 * and changes the hash. Failing loudly here is better than shipping it by accident.
 * Uses node:fs (typed via @types/node, dev-only).
 */
function productionOnly(): Plugin {
  return {
    name: "lnd-sweeper:production-only",
    apply: "build",
    configResolved(config) {
      if (!config.isProduction) {
        // Remove any earlier artefact first so a refused build cannot leave a
        // stale dist/lnd-sweeper.html behind to be hashed or uploaded by mistake.
        rmSync(resolve(config.root, config.build.outDir), { recursive: true, force: true });
        throw new Error(
          `lnd-sweeper must be built in production mode (NODE_ENV="${process.env.NODE_ENV ?? ""}", ` +
            `mode="${config.mode}"). Unset NODE_ENV or set NODE_ENV=production.`,
        );
      }
    },
  };
}

// Single self-contained HTML. No external requests except the Esplora URL the user configures.
// Build must be byte-for-byte reproducible: no timestamps, no absolute paths, no sourcemaps,
// no hashed chunk files left on disk. See scripts/verify-reproducible.sh.
export default defineConfig({
  plugins: [productionOnly(), viteSingleFile(), fixedOutputName()],
  define: {
    // Single source of truth for the version shown in the UI: package.json.
    // Declare `declare const __APP_VERSION__: string;` in src (e.g. src/vite-env.d.ts) to use it.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "es2022",
    minify: "oxc",
    sourcemap: false,
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Deterministic names even before the singlefile plugin inlines them.
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts", "test/unit/**/*.test.ts"],
    environment: "node",
  },
});
