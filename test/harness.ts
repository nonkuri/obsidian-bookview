/**
 * Dev harness: runs the real views in a browser page.
 *
 *   index.html                       -> BookPdfView on sample.pdf
 *   index.html?pdf=latin.pdf         -> BookPdfView on another fixture
 *   index.html?epub=vertical.epub    -> BookEpubView, which is what `?epub`
 *                                       selects even without a filename
 */
import { TFile, WorkspaceLeaf, type FileView } from "obsidian";
import { initPdfJs } from "../src/pdfjs";
import { BookPdfView } from "../src/view";
import { BookEpubView } from "../src/epub/view";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { DocState, EpubState } from "../src/types";

const settings = {
  ...DEFAULT_SETTINGS,
  fileStates: {} as Record<string, DocState>,
  epubStates: {} as Record<string, EpubState>,
};

const fakePlugin = {
  settings,
  defaultDocState(): DocState {
    return {
      spread: settings.defaultSpread,
      cover: settings.defaultCover,
      rtl: settings.defaultRtl,
      fit: settings.defaultFit === "custom" ? "page" : settings.defaultFit,
      zoom: 1,
      page: 1,
      rotation: 0,
    };
  },
  defaultEpubState(): EpubState {
    return {
      cfi: null,
      flow: settings.defaultFlow,
      columns: settings.defaultColumns,
      fontScale: settings.defaultFontScale,
    };
  },
  getFileState: () => null,
  saveFileState: () => undefined,
  getEpubState: () => null,
  // Kept, rather than dropped, so the driver can watch the position advance.
  saveEpubState: (path: string, state: EpubState) => {
    settings.epubStates[path] = { ...state };
  },
};

type LoadableView = FileView & { loadFileForTest(f: TFile): Promise<void> };

async function main() {
  const params = new URLSearchParams(location.search);
  const host = document.getElementById("host");
  if (!host) throw new Error("missing #host");

  const isEpub = params.has("epub");
  const name = isEpub
    ? params.get("epub") || "vertical.epub"
    : params.get("pdf") ?? "sample.pdf";

  const buffer = await (await fetch("./" + name)).arrayBuffer();
  const extension = name.split(".").pop() ?? "";
  const basename = name.slice(0, name.length - extension.length - 1);

  if (!isEpub) initPdfJs();
  const view = isEpub
    ? new BookEpubView(new WorkspaceLeaf(), fakePlugin as never)
    : new BookPdfView(new WorkspaceLeaf(), fakePlugin as never);
  view.app = {
    vault: { readBinary: async () => buffer },
    workspace: { on: () => ({}), offref: () => undefined },
  } as never;

  host.appendChild(view.containerEl);
  await view.onOpen();
  await (view as unknown as LoadableView).loadFileForTest(
    new TFile(name, basename, extension)
  );

  // Exposed so the driver can poke at the view from the console.
  (window as unknown as Record<string, unknown>).bookview = view;
  (window as unknown as Record<string, unknown>).bookviewSettings = settings;
  console.log("[harness] ready");
}

void main().catch((err) => {
  console.error("[harness] failed", err);
  const host = document.getElementById("host");
  if (host) host.textContent = "harness failed: " + String(err);
});
