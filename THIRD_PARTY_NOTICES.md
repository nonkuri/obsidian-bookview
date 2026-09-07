# Third-party notices

`main.js` is a bundle. It contains, in addition to this project's own source:

## pdf.js (pdfjs-dist 4.10.38)

- Copyright Mozilla Foundation and contributors
- License: Apache License 2.0 — full text in [licenses/pdfjs-dist-LICENSE.txt](licenses/pdfjs-dist-LICENSE.txt)
- https://github.com/mozilla/pdf.js

Bundled parts: the display API (`legacy/build/pdf.mjs`), the worker
(`legacy/build/pdf.worker.min.mjs`, inlined as a string and started from a Blob URL),
and the predefined CMap tables (`cmaps/*.bcmap`, inlined as base64).

No modifications were made to these files.

## foliate-js (commit 78914ae, 2026-05-01)

- Copyright John Factotum
- License: MIT — full text in [licenses/foliate-js-LICENSE.txt](licenses/foliate-js-LICENSE.txt)
- https://github.com/johnfactotum/foliate-js

Bundled parts: the EPUB reader and its renderers — `view.js`, `epub.js`,
`epubcfi.js`, `paginator.js`, `fixed-layout.js`, `comic-book.js`, `progress.js`,
`overlayer.js`, `text-walker.js`, `search.js`. Upstream publishes no package of
its own, so a pinned copy is vendored under `src/vendor/foliate/`; the readers
for formats BookView does not open (PDF, MOBI, FB2, …) are left out and stubbed
at build time.

No modifications were made to these files. The `.d.ts` files alongside them are
this project's, not upstream's.

foliate-js in turn vendors two libraries, bundled here through it:

- **zip.js** (`vendor/zip.js`) — Copyright Gildas Lormeau, BSD 3-Clause.
  https://github.com/gildas-lormeau/zip.js
- **fflate** (`vendor/fflate.js`) — Copyright Arjun Barrett, MIT.
  https://github.com/101arrowz/fflate
