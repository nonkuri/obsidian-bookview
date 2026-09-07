# Vendored foliate-js

The EPUB renderer, copied verbatim from
[foliate-js](https://github.com/johnfactotum/foliate-js) at commit
`78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01), MIT licensed — see
`LICENSE` in this directory.

It is vendored rather than installed because upstream publishes no package of
its own (the `foliate-js` name on npm belongs to a third party), and because its
README states plainly that the API is not stable and may change at any time.
Pinning a copy here means updates happen when we choose them.

## What is here

Only the modules `view.js` actually reaches for EPUB:

    view.js  epub.js  epubcfi.js  paginator.js  fixed-layout.js
    comic-book.js  progress.js  overlayer.js  text-walker.js  search.js
    vendor/zip.js  vendor/fflate.js

Deliberately **not** copied are the readers for the formats BookView does not
handle — `pdf.js`, `mobi.js`, `fb2.js`, `tts.js` and friends.

## Build-time adjustments

Both live in `scripts/foliate-build.mjs`, so that the files here stay identical
to upstream and updating is a straight copy rather than a patch to re-apply.

- **Unshipped readers are stubbed.** `view.js` reaches for a reader per format
  behind `await import()`. Leaving those files out is what makes the stubbing
  load-bearing: without the plugin the build fails to resolve them instead of
  quietly pulling in foliate's own 13 MB copy of pdf.js, which cannot be bundled
  as CommonJS anyway.
- **`customElements.define()` is made idempotent.** Obsidian re-evaluates a
  plugin's bundle every time it is enabled, but the window's element registry
  outlives the plugin, and defining a name twice throws `NotSupportedError` — at
  import time, before `onload()` runs, which fails the whole plugin. The
  production build refuses to emit a `main.js` still holding a bare
  `customElements.define(`.

## Updating

1. Copy the file list above from a newer upstream commit.
2. Record the new commit here.
3. Rebuild and re-run `npm run test:epub` — the vendored API is not stable, and
   `src/epub/` leans on `view.renderer`, `setStyles()`, and the shape of the
   `relocate` event in particular.

## Local modifications

None to upstream's own files — updating is a straight copy over them. The
`.d.ts` files alongside them are ours: foliate-js ships no typings, and a
relative import needs a declaration sitting next to the module it describes.
They cover only the surface `src/epub/` uses, so that an upstream change we
depend on surfaces as a compile error. Re-check them when bumping the commit.
