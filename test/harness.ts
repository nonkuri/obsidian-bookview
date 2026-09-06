/** Dev harness: runs the real BookPdfView in a browser page. */
import { TFile, WorkspaceLeaf, type FileView } from "obsidian";
import { initPdfJs } from "../src/pdfjs";
import { BookPdfView } from "../src/view";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { DocState } from "../src/types";

const settings = { ...DEFAULT_SETTINGS, fileStates: {} as Record<string, DocState> };

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
  getFileState: () => null,
  saveFileState: () => undefined,
};

async function main() {
  initPdfJs();

  const name = new URLSearchParams(location.search).get("pdf") ?? "sample.pdf";
  const response = await fetch("./" + name);
  const buffer = await response.arrayBuffer();

  const view = new BookPdfView(new WorkspaceLeaf(), fakePlugin as never);
  view.app = { vault: { readBinary: async () => buffer } } as never;

  const host = document.getElementById("host");
  if (!host) throw new Error("missing #host");
  host.appendChild(view.containerEl);

  await view.onOpen();
  await (view as unknown as FileView & { loadFileForTest(f: TFile): Promise<void> }).loadFileForTest(
    new TFile("sample.pdf", "sample", "pdf")
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
