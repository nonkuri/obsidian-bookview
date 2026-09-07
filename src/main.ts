import { Notice, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { BookViewSettingTab, DEFAULT_SETTINGS, type BookViewSettings } from "./settings";
import { disposePdfJs, initPdfJs } from "./pdfjs";
import { BookPdfView, VIEW_TYPE_BOOKVIEW_PDF } from "./view";
import { BookEpubView, VIEW_TYPE_BOOKVIEW_EPUB } from "./epub/view";
import type { DocState, EpubState } from "./types";

/**
 * Obsidian's view registry is internal, but taking over a file extension
 * requires it: `Plugin.registerExtensions()` throws outright when the extension
 * already has a handler. `.pdf` always has one, because the core viewer claims
 * it. `.epub` has none in a stock install — but another plugin may well have
 * taken it, and then the plain API throws just the same, during `onload()`,
 * which would take the whole of BookView down with it. So both go through here:
 * release whatever holds the extension, claim it, and put the old handler back
 * when we let go.
 */
interface ViewRegistryLike {
  registerExtensions(extensions: string[], viewType: string): void;
  unregisterExtensions(extensions: string[]): void;
  getTypeByExtension(extension: string): string | undefined;
  /** Every known view type. Absent on an Obsidian that keeps it somewhere else. */
  viewByType?: Record<string, unknown>;
}

/** The label used in the notice shown when an extension cannot be claimed. */
const EXTENSION_LABELS: Record<string, string> = { pdf: "PDF", epub: "EPUB" };

export default class BookViewPlugin extends Plugin {
  settings: BookViewSettings = { ...DEFAULT_SETTINGS };

  /**
   * Extensions BookView currently holds, each mapped to the view type that held
   * it before — `null` where nothing did. Unload walks this to put things back.
   */
  private claimedExtensions = new Map<string, string | null>();
  private saveFileStates = debounce(() => void this.saveSettings(), 800, false);

  async onload(): Promise<void> {
    await this.loadSettings();
    initPdfJs();

    this.registerView(VIEW_TYPE_BOOKVIEW_PDF, (leaf) => new BookPdfView(leaf, this));
    this.registerView(VIEW_TYPE_BOOKVIEW_EPUB, (leaf) => new BookEpubView(leaf, this));
    // Deferred rather than claimed here: every other plugin has finished loading
    // by the time the layout is ready, so taking an extension cannot make one of
    // them throw on its own `registerExtensions()` — and going last is also what
    // wins the extension. Enabling BookView by hand fires this immediately.
    this.app.workspace.onLayoutReady(() => this.applyExtensionOverrides());
    this.addSettingTab(new BookViewSettingTab(this.app, this));

    this.addCommand({
      id: "open-current-pdf",
      name: "Open current PDF in a book view",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== "pdf") return false;
        if (this.app.workspace.getActiveViewOfType(BookPdfView)) return false;
        if (!checking) void this.openInBookView(file, false);
        return true;
      },
    });

    // The way in when another plugin holds `.epub` and BookView could not take
    // it — clicking the file opens that plugin, so this opens BookView by hand.
    this.addCommand({
      id: "open-current-epub",
      name: "Open current EPUB in a book view",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== "epub") return false;
        if (this.app.workspace.getActiveViewOfType(BookEpubView)) return false;
        if (!checking) void this.openInBookView(file, false);
        return true;
      },
    });

    // Turning pages and showing the contents mean the same thing in both
    // viewers, so those commands follow whichever one is in front.
    this.addSharedCommand(
      "next-page",
      "Next page or spread",
      (v) => v.turn(1),
      (v) => v.turn(1)
    );
    this.addSharedCommand(
      "prev-page",
      "Previous page or spread",
      (v) => v.turn(-1),
      (v) => v.turn(-1)
    );
    this.addSharedCommand(
      "toggle-outline",
      "Toggle outline",
      (v) => void v.toggleOutline(),
      (v) => v.toggleOutline()
    );

    this.addViewCommand("toggle-spread", "Toggle two-page spread", (v) => v.toggleSpread());
    this.addViewCommand("toggle-rtl", "Toggle right-to-left binding", (v) => v.toggleRtl());
    this.addViewCommand("toggle-cover", "Toggle cover page", (v) => v.toggleCover());
    this.addViewCommand("first-page", "Go to first page", (v) => v.goToEdge("first"));
    this.addViewCommand("last-page", "Go to last page", (v) => v.goToEdge("last"));
    this.addViewCommand("fit-page", "Fit page", (v) => v.setFit("page"));
    this.addViewCommand("fit-width", "Fit width", (v) => v.setFit("width"));
    this.addViewCommand("zoom-in", "Zoom in", (v) => v.stepZoom(1));
    this.addViewCommand("zoom-out", "Zoom out", (v) => v.stepZoom(-1));
    this.addViewCommand("rotate", "Rotate clockwise", (v) => v.rotate(90));

    // For bug reports: an EPUB can open, paginate, and still show nothing, and
    // the measurements that say why are inside a closed shadow root and the
    // book's own iframe. This puts them where they can be pasted.
    this.addEpubCommand("epub-diagnostics", "Copy EPUB diagnostics", (v) => {
      const report = JSON.stringify(v.collectDiagnostics(), null, 2);
      navigator.clipboard.writeText(report).then(
        () => new Notice("BookView diagnostics copied to the clipboard."),
        () => {
          console.log("BookView diagnostics\n" + report);
          new Notice("Could not reach the clipboard; the report is in the console.");
        }
      );
    });

    this.addEpubCommand("epub-larger-type", "Larger type", (v) => v.stepFontScale(1));
    this.addEpubCommand("epub-smaller-type", "Smaller type", (v) => v.stepFontScale(-1));
    this.addEpubCommand("epub-toggle-flow", "Toggle scrolled reading", (v) => v.toggleFlow());
    this.addEpubCommand("epub-toggle-columns", "Toggle two columns", (v) =>
      v.setColumns(v.getEpubState().columns > 1 ? 1 : 2)
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        if (!viewTypeForExtension(file.extension)) return;
        menu.addItem((item) =>
          item
            .setTitle("Open in BookView")
            .setIcon("book-open")
            .onClick(() => void this.openInBookView(file, true))
        );
      })
    );

    // Keep the remembered path in step when a book is renamed or deleted.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        let moved = false;
        for (const states of [this.settings.fileStates, this.settings.epubStates]) {
          const state = states[oldPath];
          if (!state) continue;
          delete states[oldPath];
          (states as Record<string, typeof state>)[file.path] = state;
          moved = true;
        }
        if (moved) this.saveFileStates();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        let removed = false;
        for (const states of [this.settings.fileStates, this.settings.epubStates]) {
          if (!states[file.path]) continue;
          delete states[file.path];
          removed = true;
        }
        if (removed) this.saveFileStates();
      })
    );
  }

  onunload(): void {
    // Plugin.registerExtensions() would only unregister on unload, leaving the
    // extension with no handler at all, so the swap is undone by hand instead.
    this.releaseExtension("pdf");
    this.releaseExtension("epub");
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
    if (!this.settings.epubStates || typeof this.settings.epubStates !== "object") {
      this.settings.epubStates = {};
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

  defaultEpubState(): EpubState {
    return {
      cfi: null,
      flow: this.settings.defaultFlow,
      columns: this.settings.defaultColumns,
      fontScale: this.settings.defaultFontScale,
    };
  }

  getEpubState(path: string): EpubState | null {
    if (!this.settings.rememberPerFile) return null;
    return this.settings.epubStates[path] ?? null;
  }

  saveEpubState(path: string, state: EpubState): void {
    if (!this.settings.rememberPerFile) return;
    const previous = this.settings.epubStates[path];
    if (previous && epubStateEqual(previous, state)) return;
    this.settings.epubStates[path] = { ...state };
    this.saveFileStates();
  }

  /** Re-renders every open BookView after an appearance setting changed. */
  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOKVIEW_PDF)) {
      const view = leaf.view;
      if (view instanceof BookPdfView && view.hasDocument()) view.setFit(view.getDocState().fit);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOKVIEW_EPUB)) {
      const view = leaf.view;
      if (view instanceof BookEpubView && view.hasBook()) view.refreshLayout();
    }
  }

  // ------------------------------------------------------------- integration

  /** Brings both extensions in line with the settings, in either direction. */
  applyExtensionOverrides(): void {
    if (this.settings.overridePdfViewer) this.claimExtension("pdf", VIEW_TYPE_BOOKVIEW_PDF);
    else this.releaseExtension("pdf");

    if (this.settings.overrideEpubViewer) this.claimExtension("epub", VIEW_TYPE_BOOKVIEW_EPUB);
    else this.releaseExtension("epub");
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

  private claimExtension(extension: string, viewType: string): void {
    if (this.claimedExtensions.has(extension)) return;
    const label = EXTENSION_LABELS[extension] ?? extension.toUpperCase();
    const registry = this.viewRegistry();
    if (!registry) {
      new Notice(
        `BookView could not take over ${label} files. Open them from the file menu instead, ` +
          "or turn the setting off."
      );
      return;
    }
    const current = registry.getTypeByExtension(extension);
    if (current === viewType) {
      this.claimedExtensions.set(extension, null);
      return;
    }
    try {
      // Whatever held it — the core viewer, or another plugin — comes back on unload.
      if (current !== undefined) registry.unregisterExtensions([extension]);
      registry.registerExtensions([extension], viewType);
      this.claimedExtensions.set(extension, current ?? null);
    } catch (err) {
      console.error(`BookView: could not claim the .${extension} extension`, err);
      new Notice(`BookView could not take over ${label} files. See the console for details.`);
    }
  }

  private releaseExtension(extension: string): void {
    if (!this.claimedExtensions.has(extension)) return;
    const previous = this.claimedExtensions.get(extension) ?? null;
    this.claimedExtensions.delete(extension);
    const registry = this.viewRegistry();
    if (!registry) return;
    try {
      const viewType =
        extension === "pdf" ? VIEW_TYPE_BOOKVIEW_PDF : VIEW_TYPE_BOOKVIEW_EPUB;
      if (registry.getTypeByExtension(extension) === viewType) {
        registry.unregisterExtensions([extension]);
      }
      // Only hand it back to a view that still exists. The plugin we took it
      // from may have been disabled in the meantime, and pointing an extension
      // at a view type nobody serves leaves the file unopenable by anything.
      if (
        previous &&
        registry.getTypeByExtension(extension) === undefined &&
        isKnownViewType(registry, previous)
      ) {
        registry.registerExtensions([extension], previous);
      }
    } catch (err) {
      console.error(`BookView: could not release the .${extension} extension`, err);
    }
  }

  /**
   * Opens a file in BookView regardless of what holds its extension. This is
   * what makes BookView usable alongside another plugin that owns `.epub`.
   */
  private async openInBookView(file: TFile, newLeaf: boolean): Promise<void> {
    const type = viewTypeForExtension(file.extension);
    if (!type) return;
    const leaf: WorkspaceLeaf = newLeaf
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type, state: { file: file.path }, active: true });
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

  private addEpubCommand(id: string, name: string, run: (view: BookEpubView) => void): void {
    this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BookEpubView);
        if (!view || !view.hasBook()) return false;
        if (!checking) run(view);
        return true;
      },
    });
  }

  /** One command, dispatched to whichever of the two viewers is active. */
  private addSharedCommand(
    id: string,
    name: string,
    runPdf: (view: BookPdfView) => void,
    runEpub: (view: BookEpubView) => void
  ): void {
    this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        const pdf = this.app.workspace.getActiveViewOfType(BookPdfView);
        if (pdf?.hasDocument()) {
          if (!checking) runPdf(pdf);
          return true;
        }
        const epub = this.app.workspace.getActiveViewOfType(BookEpubView);
        if (epub?.hasBook()) {
          if (!checking) runEpub(epub);
          return true;
        }
        return false;
      },
    });
  }
}

/**
 * Whether the registry still serves `viewType`. Unknowable on a build that does
 * not expose the table, and then we assume it does — the old behaviour.
 */
function isKnownViewType(registry: ViewRegistryLike, viewType: string): boolean {
  const known = registry.viewByType;
  if (!known || typeof known !== "object") return true;
  return Object.prototype.hasOwnProperty.call(known, viewType);
}

/** The BookView view type for a file extension, or `null` if it opens neither. */
function viewTypeForExtension(extension: string): string | null {
  switch (extension.toLowerCase()) {
    case "pdf":
      return VIEW_TYPE_BOOKVIEW_PDF;
    case "epub":
      return VIEW_TYPE_BOOKVIEW_EPUB;
    default:
      return null;
  }
}

function epubStateEqual(a: EpubState, b: EpubState): boolean {
  return (
    a.cfi === b.cfi &&
    a.flow === b.flow &&
    a.columns === b.columns &&
    a.fontScale === b.fontScale
  );
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
