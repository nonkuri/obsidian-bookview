// Checks how the plugin takes over and hands back the `.pdf` extension, against
// a registry that behaves exactly like Obsidian's ViewRegistry:
//
//   registerExtensions   throws if the extension already has a handler
//   unregisterExtensions deletes the mapping
//   getTypeByExtension   reads it back
//
// That throw is the whole reason this code exists, so it is worth pinning down.
import esbuild from "esbuild";
import { createRequire } from "module";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);

const outfile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bookview-")), "main.cjs");

await esbuild.build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile,
  alias: { obsidian: path.join(here, "obsidian.ts") },
  // The view and pdf.js are irrelevant here, and pdf.js will not load headless.
  plugins: [
    {
      name: "stub-view-and-pdfjs",
      setup(build) {
        build.onResolve({ filter: /\.\/(view|pdfjs)$/ }, (args) => ({
          path: args.path,
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents:
            args.path === "./view"
              ? `export const VIEW_TYPE_BOOKVIEW_PDF = "bookview-pdf";
                 export class BookPdfView {}`
              : `export function initPdfJs() {}
                 export function disposePdfJs() {}`,
          loader: "js",
        }));
      },
    },
  ],
  logLevel: "warning",
});

const BookViewPlugin = require(outfile).default;

function makeRegistry(initial) {
  const typeByExtension = { ...initial };
  return {
    typeByExtension,
    registerExtensions(exts, type) {
      for (const ext of exts) {
        if (Object.prototype.hasOwnProperty.call(typeByExtension, ext)) {
          throw new Error(`Attempting to register an existing file extension "${ext}"`);
        }
      }
      for (const ext of exts) typeByExtension[ext] = type;
    },
    unregisterExtensions(exts) {
      for (const ext of exts) delete typeByExtension[ext];
    },
    getTypeByExtension(ext) {
      return typeByExtension[ext];
    },
  };
}

async function makePlugin(initial, overridePdfViewer = true) {
  const registry = makeRegistry(initial);
  const notices = [];
  const app = {
    viewRegistry: registry,
    workspace: { on: () => ({}), getLeavesOfType: () => [] },
    vault: { on: () => ({}) },
  };
  const plugin = new BookViewPlugin(app, { id: "bookview", dir: ".obsidian/plugins/bookview" });
  await plugin.loadSettings();
  plugin.settings.overridePdfViewer = overridePdfViewer;
  globalThis.__notices = notices;
  return { plugin, registry, notices };
}

// The stub Notice logs to console; capture it instead so a failure is visible.
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.map(String).join(" "));

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  originalError(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n      got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`));
};

// 1. The normal case: the core PDF viewer already owns `.pdf`.
{
  const { plugin, registry } = await makePlugin({ pdf: "pdf", md: "markdown" });
  plugin.applyPdfExtensionOverride();
  check("core viewer replaced", registry.getTypeByExtension("pdf"), "bookview-pdf");
  check("other extensions untouched", registry.getTypeByExtension("md"), "markdown");
  plugin.onunload();
  check("core viewer restored on unload", registry.getTypeByExtension("pdf"), "pdf");
}

// 2. Another plugin owns it; that one has to come back, not the core viewer.
{
  const { plugin, registry } = await makePlugin({ pdf: "some-other-pdf-view" });
  plugin.applyPdfExtensionOverride();
  check("other plugin replaced", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.onunload();
  check("other plugin restored", registry.getTypeByExtension("pdf"), "some-other-pdf-view");
}

// 3. Nothing owns it.
{
  const { plugin, registry } = await makePlugin({});
  plugin.applyPdfExtensionOverride();
  check("claimed when unowned", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.onunload();
  check("left unowned on unload", registry.getTypeByExtension("pdf"), undefined);
}

// 4. Toggling the setting at runtime, repeatedly, must not throw or drift.
{
  const { plugin, registry } = await makePlugin({ pdf: "pdf" });
  plugin.applyPdfExtensionOverride();
  plugin.applyPdfExtensionOverride(); // idempotent
  check("claim is idempotent", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.settings.overridePdfViewer = false;
  plugin.applyPdfExtensionOverride();
  check("setting off hands it back", registry.getTypeByExtension("pdf"), "pdf");
  plugin.settings.overridePdfViewer = true;
  plugin.applyPdfExtensionOverride();
  check("setting on takes it again", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.settings.overridePdfViewer = false;
  plugin.applyPdfExtensionOverride();
  check("second round-trip restores", registry.getTypeByExtension("pdf"), "pdf");
}

// 5. Starting with the override disabled must leave the core viewer alone.
{
  const { plugin, registry } = await makePlugin({ pdf: "pdf" }, false);
  plugin.applyPdfExtensionOverride();
  check("override off is a no-op", registry.getTypeByExtension("pdf"), "pdf");
}

console.error = originalError;
check("no errors logged", errors, []);

await fs.rm(path.dirname(outfile), { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
