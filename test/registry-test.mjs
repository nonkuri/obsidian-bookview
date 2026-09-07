// Checks how the plugin takes over and hands back the `.pdf` and `.epub`
// extensions, against a registry that behaves exactly like Obsidian's
// ViewRegistry:
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
        build.onResolve({ filter: /\.\/(view|pdfjs|epub\/view)$/ }, (args) => ({
          path: args.path,
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents:
            args.path === "./view"
              ? `export const VIEW_TYPE_BOOKVIEW_PDF = "bookview-pdf";
                 export class BookPdfView {}`
              : args.path === "./epub/view"
              ? `export const VIEW_TYPE_BOOKVIEW_EPUB = "bookview-epub";
                 export class BookEpubView {}`
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

function makeRegistry(initial, knownViewTypes) {
  const typeByExtension = { ...initial };
  return {
    typeByExtension,
    // Obsidian's own table of view types. `undefined` stands for a build that
    // does not expose it, which the plugin has to cope with.
    viewByType:
      knownViewTypes === undefined
        ? undefined
        : Object.fromEntries(knownViewTypes.map((t) => [t, true])),
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

async function makePlugin(initial, overrides = {}, knownViewTypes) {
  const registry = makeRegistry(initial, knownViewTypes);
  const notices = [];
  const app = {
    viewRegistry: registry,
    workspace: {
      on: () => ({}),
      getLeavesOfType: () => [],
      // Obsidian runs the callback at once when a plugin is enabled by hand,
      // which is the path these checks take.
      onLayoutReady: (cb) => cb(),
    },
    vault: { on: () => ({}) },
  };
  const plugin = new BookViewPlugin(app, { id: "bookview", dir: ".obsidian/plugins/bookview" });
  await plugin.loadSettings();
  plugin.settings.overridePdfViewer = overrides.pdf ?? true;
  plugin.settings.overrideEpubViewer = overrides.epub ?? true;
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
  plugin.applyExtensionOverrides();
  check("core viewer replaced", registry.getTypeByExtension("pdf"), "bookview-pdf");
  check("other extensions untouched", registry.getTypeByExtension("md"), "markdown");
  plugin.onunload();
  check("core viewer restored on unload", registry.getTypeByExtension("pdf"), "pdf");
}

// 2. Another plugin owns it; that one has to come back, not the core viewer.
{
  const { plugin, registry } = await makePlugin({ pdf: "some-other-pdf-view" });
  plugin.applyExtensionOverrides();
  check("other plugin replaced", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.onunload();
  check("other plugin restored", registry.getTypeByExtension("pdf"), "some-other-pdf-view");
}

// 3. Nothing owns it.
{
  const { plugin, registry } = await makePlugin({});
  plugin.applyExtensionOverrides();
  check("claimed when unowned", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.onunload();
  check("left unowned on unload", registry.getTypeByExtension("pdf"), undefined);
}

// 4. Toggling the setting at runtime, repeatedly, must not throw or drift.
{
  const { plugin, registry } = await makePlugin({ pdf: "pdf" });
  plugin.applyExtensionOverrides();
  plugin.applyExtensionOverrides(); // idempotent
  check("claim is idempotent", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.settings.overridePdfViewer = false;
  plugin.applyExtensionOverrides();
  check("setting off hands it back", registry.getTypeByExtension("pdf"), "pdf");
  plugin.settings.overridePdfViewer = true;
  plugin.applyExtensionOverrides();
  check("setting on takes it again", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.settings.overridePdfViewer = false;
  plugin.applyExtensionOverrides();
  check("second round-trip restores", registry.getTypeByExtension("pdf"), "pdf");
}

// 5. `.epub` in a stock vault: nothing holds it, and it must come back unowned.
{
  const { plugin, registry } = await makePlugin({ pdf: "pdf", md: "markdown" });
  await plugin.onload();
  check("epub claimed when unowned", registry.getTypeByExtension("epub"), "bookview-epub");
  check("pdf taken over too", registry.getTypeByExtension("pdf"), "bookview-pdf");
  check("the plain helper is never used", plugin.registeredExtensions, []);
  plugin.onunload();
  check("epub left unowned on unload", registry.getTypeByExtension("epub"), undefined);
  check("pdf handed back", registry.getTypeByExtension("pdf"), "pdf");
}

// 6. Another plugin already owns `.epub`. This is the case that made the plain
// `registerExtensions()` wrong: it throws, and inside onload() that would take
// the whole plugin down, PDF support with it.
{
  const { plugin, registry } = await makePlugin({ pdf: "pdf", epub: "some-epub-plugin" });
  await plugin.onload();
  check("epub taken from the other plugin", registry.getTypeByExtension("epub"), "bookview-epub");
  check("pdf survived the epub claim", registry.getTypeByExtension("pdf"), "bookview-pdf");
  plugin.onunload();
  check("other epub plugin restored", registry.getTypeByExtension("epub"), "some-epub-plugin");
}

// 7. Toggling the EPUB setting at runtime hands the extension back and forth.
{
  const { plugin, registry } = await makePlugin({ epub: "some-epub-plugin" });
  plugin.applyExtensionOverrides();
  check("epub claimed", registry.getTypeByExtension("epub"), "bookview-epub");
  plugin.settings.overrideEpubViewer = false;
  plugin.applyExtensionOverrides();
  check("epub setting off restores the other plugin", registry.getTypeByExtension("epub"), "some-epub-plugin");
  plugin.settings.overrideEpubViewer = true;
  plugin.applyExtensionOverrides();
  check("epub setting on takes it again", registry.getTypeByExtension("epub"), "bookview-epub");
}

// 8. The plugin we took `.epub` from has since been disabled. Handing the
// extension back to a view type nobody serves would leave EPUBs unopenable by
// anything at all, so it must be left unowned instead.
{
  const { plugin, registry } = await makePlugin(
    { epub: "some-epub-plugin" },
    {},
    // The other plugin's view type is gone from the registry by unload time.
    ["bookview-pdf", "bookview-epub", "markdown"]
  );
  plugin.applyExtensionOverrides();
  check("epub claimed from the doomed plugin", registry.getTypeByExtension("epub"), "bookview-epub");
  plugin.onunload();
  check("dead view type not restored", registry.getTypeByExtension("epub"), undefined);
}

// 9. On a build that does not expose the view table, restore as before.
{
  const { plugin, registry } = await makePlugin({ epub: "some-epub-plugin" }, {}, undefined);
  plugin.applyExtensionOverrides();
  plugin.onunload();
  check(
    "restored when the table is unknowable",
    registry.getTypeByExtension("epub"),
    "some-epub-plugin"
  );
}

// 10. Starting with both overrides disabled must leave everything alone.
{
  const { plugin, registry } = await makePlugin(
    { pdf: "pdf", epub: "some-epub-plugin" },
    { pdf: false, epub: false }
  );
  plugin.applyExtensionOverrides();
  check("pdf override off is a no-op", registry.getTypeByExtension("pdf"), "pdf");
  check("epub override off is a no-op", registry.getTypeByExtension("epub"), "some-epub-plugin");
}

console.error = originalError;
check("no errors logged", errors, []);

await fs.rm(path.dirname(outfile), { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
