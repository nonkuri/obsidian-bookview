import { Notice, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { BookViewSettingTab, DEFAULT_SETTINGS, type BookViewSettings } from "./settings";
import { disposePdfJs, initPdfJs } from "./pdfjs";
import { BookPdfView, VIEW_TYPE_BOOKVIEW_PDF } from "./view";
import type { DocState } from "./types";

/**
 * Obsidian's view registry is internal, but taking over `.pdf` requires it:
 * `Plugin.registerExtensions()` throws outright when the extension already has
 * a handler — and `.pdf` always does, because the core PDF viewer claims it.
 * The extension has to be released first, and put back when we let go.
 */
interface ViewRegistryLike {
  registerExtensions(extensions: string[], viewType: string): void;
  unregisterExtensions(extensions: string[]): void;
  getTypeByExtension(extension: string): string | undefined;
}

export default class BookViewPlugin extends Plugin {
  settings: BookViewSettings = { ...DEFAULT_SETTINGS };

  private extensionRegistered = false;
  /** What handled `.pdf` before we took it over, so unload can put it back. */
  private previousPdfViewType: string | null = null;
  private saveFileStates = debounce(() => void this.saveSettings(), 800, false);

  async onload(): Promise<void> {
    await this.loadSettings();
    initPdfJs();

    this.registerView(VIEW_TYPE_BOOKVIEW_PDF, (leaf) => new BookPdfView(leaf, this));
    this.applyPdfExtensionOverride();
    this.addSettingTab(new BookViewSettingTab(this.app, this));

    this.addCommand({
      id: "open-in-bookview",
      name: "Open current PDF in a book view",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== "pdf") return false;
        if (this.app.workspace.getActiveViewOfType(BookPdfView)) return false;
        if (!checking) void this.openInBookView(file, false);
        return true;
      },
    });

    this.addViewCommand("toggle-spread", "Toggle two-page spread", (v) => v.toggleSpread());
    this.addViewCommand("toggle-rtl", "Toggle right-to-left binding", (v) => v.toggleRtl());
    this.addViewCommand("toggle-cover", "Toggle cover page", (v) => v.toggleCover());
    this.addViewCommand("toggle-outline", "Toggle outline", (v) => void v.toggleOutline());
    this.addViewCommand("next-page", "Next page or spread", (v) => v.turn(1));
    this.addViewCommand("prev-page", "Previous page or spread", (v) => v.turn(-1));
    this.addViewCommand("first-page", "Go to first page", (v) => v.goToEdge("first"));
    this.addViewCommand("last-page", "Go to last page", (v) => v.goToEdge("last"));
    this.addViewCommand("fit-page", "Fit page", (v) => v.setFit("page"));
    this.addViewCommand("fit-width", "Fit width", (v) => v.setFit("width"));
    this.addViewCommand("zoom-in", "Zoom in", (v) => v.stepZoom(1));
    this.addViewCommand("zoom-out", "Zoom out", (v) => v.stepZoom(-1));
    this.addViewCommand("rotate", "Rotate clockwise", (v) => v.rotate(90));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return;
        menu.addItem((item) =>
          item
            .setTitle("Open in BookView")
            .setIcon("book-open")
            .onClick(() => void this.openInBookView(file, true))
        );
      })
    );

    // Keep the remembered path in step when a PDF is renamed or deleted.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const state = this.settings.fileStates[oldPath];
        if (!state) return;
        delete this.settings.fileStates[oldPath];
        this.settings.fileStates[file.path] = state;
        this.saveFileStates();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!this.settings.fileStates[file.path]) return;
        delete this.settings.fileStates[file.path];
        this.saveFileStates();
      })
    );
  }

  onunload(): void {
    // Plugin.registerExtensions() would only unregister on unload, leaving .pdf
    // with no handler at all, so the swap is undone by hand instead.
    this.releasePdfExtension();
    this.saveFileStates.cancel();
    disposePdfJs();
  }

  // ---------------------------------------------------------------- settings

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<BookViewSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    if (!this.settings.fileStates || typeof this.settings.fileStates !== "object") {
      this.settings.fileStates = {};
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  defaultDocState(): DocState {
    return {
      spread: this.settings.defaultSpread,
      cover: this.settings.defaultCover,
      rtl: this.settings.defaultRtl,
      fit: this.settings.defaultFit === "custom" ? "page" : this.settings.defaultFit,
      zoom: 1,
      page: 1,
      rotation: 0,
    };
  }

  getFileState(path: string): DocState | null {
    if (!this.settings.rememberPerFile) return null;
    return this.settings.fileStates[path] ?? null;
  }

  saveFileState(path: string, state: DocState): void {
    if (!this.settings.rememberPerFile) return;
    const previous = this.settings.fileStates[path];
    if (previous && shallowEqual(previous, state)) return;
    this.settings.fileStates[path] = { ...state };
    this.saveFileStates();
  }

  /** Re-renders every open BookView after an appearance setting changed. */
  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOKVIEW_PDF)) {
      const view = leaf.view;
      if (view instanceof BookPdfView && view.hasDocument()) view.setFit(view.getDocState().fit);
    }
  }

  // ------------------------------------------------------------- integration

  applyPdfExtensionOverride(): void {
    if (this.settings.overridePdfViewer) this.claimPdfExtension();
    else this.releasePdfExtension();
  }

  private viewRegistry(): ViewRegistryLike | null {
    const registry = (this.app as unknown as { viewRegistry?: ViewRegistryLike }).viewRegistry;
    if (
      registry &&
      typeof registry.registerExtensions === "function" &&
      typeof registry.unregisterExtensions === "function" &&
      typeof registry.getTypeByExtension === "function"
    ) {
      return registry;
    }
    return null;
  }

  private claimPdfExtension(): void {
    if (this.extensionRegistered) return;
    const registry = this.viewRegistry();
    if (!registry) {
      new Notice(
        "BookView could not take over PDF files. Open them from the file menu instead, or turn the setting off."
      );
      return;
    }
    const current = registry.getTypeByExtension("pdf");
    if (current === VIEW_TYPE_BOOKVIEW_PDF) {
      this.extensionRegistered = true;
      return;
    }
    try {
      // Whatever held `.pdf` (normally the core viewer) is restored on unload.
      this.previousPdfViewType = current ?? null;
      if (current !== undefined) registry.unregisterExtensions(["pdf"]);
      registry.registerExtensions(["pdf"], VIEW_TYPE_BOOKVIEW_PDF);
      this.extensionRegistered = true;
    } catch (err) {
      console.error("BookView: could not claim the .pdf extension", err);
      new Notice("BookView could not take over PDF files. See the console for details.");
    }
  }

  private releasePdfExtension(): void {
    if (!this.extensionRegistered) return;
    const registry = this.viewRegistry();
    if (!registry) return;
    try {
      if (registry.getTypeByExtension("pdf") === VIEW_TYPE_BOOKVIEW_PDF) {
        registry.unregisterExtensions(["pdf"]);
      }
      if (this.previousPdfViewType && registry.getTypeByExtension("pdf") === undefined) {
        registry.registerExtensions(["pdf"], this.previousPdfViewType);
      }
    } catch (err) {
      console.error("BookView: could not release the .pdf extension", err);
    }
    this.previousPdfViewType = null;
    this.extensionRegistered = false;
  }

  private async openInBookView(file: TFile, newLeaf: boolean): Promise<void> {
    const leaf: WorkspaceLeaf = newLeaf
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_BOOKVIEW_PDF,
      state: { file: file.path },
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private addViewCommand(id: string, name: string, run: (view: BookPdfView) => void): void {
    this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BookPdfView);
        if (!view || !view.hasDocument()) return false;
        if (!checking) run(view);
        return true;
      },
    });
  }
}

function shallowEqual(a: DocState, b: DocState): boolean {
  return (
    a.spread === b.spread &&
    a.cover === b.cover &&
    a.rtl === b.rtl &&
    a.fit === b.fit &&
    a.zoom === b.zoom &&
    a.page === b.page &&
    a.rotation === b.rotation
  );
}
