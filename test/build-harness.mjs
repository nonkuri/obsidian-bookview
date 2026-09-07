// Bundles the dev harness (real view + stubbed obsidian API) into test/harness.js.
import esbuild from "esbuild";
import { createRequire } from "module";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const inlineAssets = {
  name: "pdfjs-inline-assets",
  setup(build) {
    build.onResolve({ filter: /^pdfjs-(worker-source|cmaps)$/ }, (args) => ({
      path: args.path,
      namespace: "pdfjs-asset",
    }));
    build.onLoad({ filter: /.*/, namespace: "pdfjs-asset" }, async (args) => {
      if (args.path === "pdfjs-worker-source") {
        const file = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
        return { contents: await fs.readFile(file, "utf8"), loader: "text" };
      }
      const cmapDir = path.join(
        path.dirname(require.resolve("pdfjs-dist/package.json")),
        "cmaps"
      );
      const table = {};
      for (const name of (await fs.readdir(cmapDir)).filter((n) => n.endsWith(".bcmap")).sort()) {
        table[name.replace(/\.bcmap$/, "")] = (
          await fs.readFile(path.join(cmapDir, name))
        ).toString("base64");
      }
      return { contents: JSON.stringify(table), loader: "json" };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(here, "harness.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  sourcemap: "inline",
  outfile: path.join(here, "harness.js"),
  plugins: [inlineAssets],
  alias: { obsidian: path.join(here, "obsidian.ts") },
  logLevel: "info",
});
