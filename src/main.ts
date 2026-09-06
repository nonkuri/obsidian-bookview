import { Notice, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { BookViewSettingTab, DEFAULT_SETTINGS, type BookViewSettings } from "./settings";
import { disposePdfJs, initPdfJs } from "./pdfjs";
import { BookPdfView, VIEW_TYPE_BOOKVIEW_PDF } from "./view";
import type { DocState } from "./types";

/** Obsidian's view registry is internal, but it is the only way to hand `.pdf` back. */
interface ViewRegistryLike {
  unregisterExtensions(extensions: string[]): void;
  typeByExtension: Record<string, string>;
}

export default class BookViewPlugin extends Plugin {
  settings: BookViewSettings = { ...DEFAULT_SETTINGS };

  private extensionRegistered = false;
  private saveFileStates = debounce(() => void this.saveSettings(), 800, false);

  async onload(): Promise<void> {
    await this.loadSettings();
    initPdfJs();

    this.registerView(VIEW_TYPE_BOOKVIEW_PDF, (leaf) => new BookPdfView(leaf, this));
    this.applyPdfExtensionOverride();
    this.addSettingTab(new BookViewSettingTab(this.app, this));

    this.addCommand({
      id: "open-in-bookview",
      name: "Open current PDF in BookView (この PDF を BookView で開く)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== "pdf") return false;
        if (this.app.workspace.getActiveViewOfType(BookPdfView)) return false;
        if (!checking) void this.openInBookView(file, false);
        return true;
      },
    });

    this.addViewCommand("toggle-spread", "Toggle two-page spread (見開き表示の切り替え)", (v) =>
      v.toggleSpread()
    );
    this.addViewCommand("toggle-rtl", "Toggle right-to-left binding (右綴じ／左綴じの切り替え)", (v) =>
      v.toggleRtl()
    );
    this.addViewCommand("toggle-cover", "Toggle cover page (表紙を単独表示するかの切り替え)", (v) =>
      v.toggleCover()
    );
    this.addViewCommand("next-page", "Next page / spread (次のページへ)", (v) => v.turn(1));
    this.addViewCommand("prev-page", "Previous page / spread (前のページへ)", (v) => v.turn(-1));
    this.addViewCommand("first-page", "First page (最初のページへ)", (v) => v.goToEdge("first"));
    this.addViewCommand("last-page", "Last page (最後のページへ)", (v) => v.goToEdge("last"));
    this.addViewCommand("fit-page", "Fit page (全体を表示)", (v) => v.setFit("page"));
    this.addViewCommand("fit-width", "Fit width (幅に合わせる)", (v) => v.setFit("width"));
    this.addViewCommand("zoom-in", "Zoom in (拡大)", (v) => v.stepZoom(1));
    this.addViewCommand("zoom-out", "Zoom out (縮小)", (v) => v.stepZoom(-1));
    this.addViewCommand("rotate", "Rotate clockwise (右に回転)", (v) => v.rotate(90));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return;
        menu.addItem((item) =>
          item
            .setTitle("BookView で開く")
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
    const want = this.settings.overridePdfViewer;
    if (want === this.extensionRegistered) return;

    if (want) {
      try {
        this.registerExtensions(["pdf"], VIEW_TYPE_BOOKVIEW_PDF);
        this.extensionRegistered = true;
      } catch (err) {
        new Notice("PDF の関連付けに失敗しました。別のプラグインが .pdf を使っている可能性があります。");
        console.error("BookView: registerExtensions failed", err);
      }
      return;
    }

    const registry = (this.app as unknown as { viewRegistry?: ViewRegistryLike }).viewRegistry;
    if (registry && typeof registry.unregisterExtensions === "function") {
      try {
        registry.unregisterExtensions(["pdf"]);
        this.extensionRegistered = false;
        return;
      } catch (err) {
        console.error("BookView: unregisterExtensions failed", err);
      }
    }
    new Notice("設定を反映するには Obsidian を再読み込みしてください。");
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
    this.app.workspace.revealLeaf(leaf);
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
