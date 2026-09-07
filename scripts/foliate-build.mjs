import fs from "fs/promises";
import path from "path";

/**
 * esbuild support for the vendored foliate-js (see src/vendor/foliate/README.md).
 *
 * Both plugins here exist so the vendored files can stay byte-identical to
 * upstream: updating is a straight copy, and the adjustments live at build time
 * instead of as a patch someone has to remember to re-apply.
 *
 * Shared by the plugin build and the dev harness so the two cannot drift.
 */

/* ------------------------------------------------ readers we do not ship -- */

const STUBBED_READERS = new Set(["pdf", "mobi", "fb2", "opds", "tts", "dict"]);

// Only the shapes `view.js` destructures. Reaching one means a file slipped past
// the extension check, so they fail loudly rather than silently.
const STUB_SOURCE = `
  const unsupported = () => { throw new Error("BookView: unsupported e-book format"); };
  export const makePDF = unsupported;
  export const makeFB2 = unsupported;
  export const isMOBI = () => false;
  export class MOBI {}
  export class TTS {}
`;

/**
 * foliate-js reaches for a reader per e-book format behind `await import()`, and
 * BookView vendors only the EPUB ones. The rest resolve to an empty module.
 *
 * This is not an optimisation. foliate's own `pdf.js` pulls in its 13 MB copy of
 * pdf.js — a second one, next to the copy BookView already bundles — and uses
 * top-level `await` and `import.meta`, neither of which survives a CommonJS
 * build. Without this the build fails outright, which is the intent: leaving
 * those files out of `src/vendor/foliate/` is what makes the substitution
 * load-bearing rather than merely tidy.
 */
export const stubFoliateReaders = {
  name: "foliate-stub-readers",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/[\w-]+\.js$/ }, (args) => {
      if (!args.importer.includes("foliate")) return null;
      const name = path.basename(args.path, ".js");
      if (!STUBBED_READERS.has(name)) return null;
      return { path: "foliate-stub:" + name, namespace: "foliate-stub" };
    });

    build.onLoad({ filter: /.*/, namespace: "foliate-stub" }, () => ({
      contents: STUB_SOURCE,
      loader: "js",
    }));
  },
};

/* ------------------------------------------- custom elements on a reload -- */

const DEFINE_HELPER = `
const __bookviewDefineElement = (registry, name, ctor, options) => {
  // Obsidian re-evaluates a plugin's bundle every time it is enabled, but the
  // window's custom-element registry outlives the plugin, and defining a name
  // twice throws NotSupportedError — at import time, which kills the whole
  // plugin before onload() runs. The definition already there is from an
  // identical copy of this same vendored build, so keeping it is correct.
  if (registry.get(name)) return;
  registry.define(name, ctor, options);
};
`;

/** Matches the vendored foliate modules, but not the libraries nested under them. */
const FOLIATE_MODULE = /[\\/]vendor[\\/]foliate[\\/][\w-]+\.js$/;

/**
 * Makes foliate's module-scope `customElements.define()` calls idempotent.
 *
 * Without this, BookView loads exactly once per Obsidian window: the second
 * enable throws and the plugin fails wholesale, PDF support with it.
 */
export const guardFoliateCustomElements = {
  name: "foliate-guard-custom-elements",
  setup(build) {
    build.onLoad({ filter: FOLIATE_MODULE }, async (args) => {
      const source = await fs.readFile(args.path, "utf8");
      if (!source.includes("customElements.define(")) return null;
      const contents =
        DEFINE_HELPER +
        source.replaceAll("customElements.define(", "__bookviewDefineElement(customElements, ");
      return { contents, loader: "js" };
    });
  },
};

export const foliatePlugins = [stubFoliateReaders, guardFoliateCustomElements];
