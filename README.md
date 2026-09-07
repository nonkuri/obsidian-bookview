# BookView

日本語の説明は [README.ja.md](README.ja.md) にあります。

A PDF viewer for Obsidian that displays two-page spreads the way a printed book
does — including **right-to-left binding**, as used by vertically written
Japanese books, and Acrobat Reader's **cover page** option.

Obsidian's built-in PDF viewer scrolls one page at a time. BookView pairs the
pages instead, puts them in the right order for the binding, and turns them with
the arrow keys.

![A vertically set Japanese book, bound on the right, with the outline panel open](screenshot/vertical-right-bound.png)

*A right-bound Japanese book: page 51 on the left, page 50 on the right, with the
document's outline in the side panel.*

![An English book, bound on the left](screenshot/horizontal-left-bound.png)

*The same viewer on a left-bound English book, which BookView recognises on its
own.*

## Features

- **Two-page spread or single page**, switchable at any time.
- **Right-to-left or left-to-right binding.** With right-to-left binding the
  pages run right to left: in the spread 2-3, page 2 is on the right and page 3
  on the left, the order a Japanese book is actually printed in. The arrow keys
  follow the binding, so `←` means "next" in a right-bound book.
- **Show cover page.** Page 1 is shown on its own and pairing restarts at page 2
  (2-3, 4-5, …), so page numbers land on the sides they do in print. A page with
  no partner, such as the cover or a final page, is kept on the binding side
  rather than centred — in a right-bound book, that puts page 1 on the left
  half, exactly where it lands when you open the front cover.
- **Works out the binding on its own.** `/ViewerPreferences /Direction /R2L`
  selects right-to-left binding and `/PageLayout /TwoPageRight` selects a spread
  with a separate cover — but hardly any PDF says either, so the binding is
  otherwise read from the text itself: vertically set Japanese, Hebrew and Arabic
  open right-bound, and a document with none of those opens left-bound. What
  stays ambiguous — horizontally set Japanese, or a scan with no text at all —
  keeps whichever default you set.
- **Outline panel.** The document's own outline (its bookmarks) is shown as a
  collapsible tree; clicking an entry jumps to its page, and the entry covering
  the current page is highlighted. The panel is empty for PDFs that carry no
  outline.
- **Zoom and rotate.** Fit page, fit width, fixed zoom levels, 90° rotation.
- **Per-file memory.** Binding direction, spread mode, and the current page are
  restored the next time you open the file.
- **CJK support built in.** The pdf.js CMap tables are bundled, so PDFs that use
  a predefined encoding (`UniJIS-UCS2-H`, `90ms-RKSJ-H`, …) render correctly.
- **No network access.** pdf.js, its worker, and the CMaps are all bundled into
  `main.js`; nothing is fetched at runtime.

## Usage

Open any PDF in your vault. By default BookView handles `.pdf` files in place of
the built-in viewer; you can turn that off in the settings and open individual
files with **Open in BookView** from the file menu, or from the command palette.

| Key | Action |
| --- | --- |
| `←` / `→` | Next / previous, flipped to match the binding |
| `↑` `↓` `PageUp` `PageDown` `Space` | Previous / next |
| `Home` / `End` | First / last page |
| `+` / `-` | Zoom in / out |
| `0` | Fit page |
| `W` | Fit width |
| `S` | Toggle two-page spread |
| `C` | Toggle cover page |
| `R` | Toggle right-to-left binding |
| `T` | Toggle the outline panel |

- Mouse wheel turns pages. When the spread is zoomed past the edge of the
  window, it scrolls first and turns the page once it reaches the end.
- `Ctrl` / `Cmd` + wheel zooms.

Every action is also a command, so you can assign your own hotkeys under
**Settings → Hotkeys**.

## Settings

- Defaults for newly opened PDFs: spread, binding direction, cover page, zoom.
- Whether a PDF's own layout hints override those defaults.
- Appearance: aligning lone pages to the binding edge, the gap between the
  halves of a spread, page shadow, colour inversion in dark mode, and render
  quality.
- Whether BookView handles `.pdf` files, and whether per-file state is stored.

## Installation

### From Obsidian

**Settings → Community plugins → Browse**, search for **BookView**, install, and
enable it.

### Manually

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/nonkuri/obsidian-bookview/releases/latest)
and put them in `<vault>/.obsidian/plugins/bookview/`, then enable the plugin
under **Settings → Community plugins**.

## Limitations

- There is no text layer, so text cannot be selected, copied, or searched. Pages
  are rendered as images.
- Links inside a page are not clickable, since annotations are not drawn. Use the
  outline panel to move around the document.
- PDFs embedded in notes (`![[file.pdf]]`) still use Obsidian's own rendering.
- CJK PDFs without embedded fonts fall back to the fonts available on the
  system.

## Development

```bash
npm install
npm run dev      # esbuild in watch mode
npm run build    # type check and production build
```

`npm run deploy -- "C:/path/to/Vault"` copies the built files into a vault.

### Test harness

The view can be run in a plain browser, without starting Obsidian:

```bash
npm run test:pdf      # generate test/sample.pdf (5 pages, right-bound, outline, Japanese text)
npm run test:build    # build test/harness.js
npm run test:serve    # http://localhost:4321/test/index.html
```

`test/obsidian.ts` is a minimal stub of the Obsidian API and is not part of the
plugin bundle.

## Credits and licence

MIT — see [LICENSE](LICENSE).

Bundles [pdf.js](https://github.com/mozilla/pdf.js) by the Mozilla Foundation,
under the Apache License 2.0. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
