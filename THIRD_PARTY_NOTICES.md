# Third-party notices

`main.js` is a bundle. It contains, in addition to this project's own source:

## pdf.js (pdfjs-dist 3.11.174)

- Copyright Mozilla Foundation and contributors
- License: Apache License 2.0 — full text in [licenses/pdfjs-dist-LICENSE.txt](licenses/pdfjs-dist-LICENSE.txt)
- https://github.com/mozilla/pdf.js

Bundled parts: the display API (`legacy/build/pdf.js`), the worker
(`legacy/build/pdf.worker.min.js`, inlined as a string and started from a Blob URL),
and the predefined CMap tables (`cmaps/*.bcmap`, inlined as base64).

No modifications were made to these files.
