import { FileView, Menu, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { ViewStateResult } from "obsidian";
import type BookViewPlugin from "../main";
import type { EpubState, FlowMode } from "../types";
import { EPUB_MARGIN_MAX, EPUB_MARGIN_STEP } from "../settings";
import { openEpub } from "./loader";
import "../vendor/foliate/view.js";
import type { Book, LoadDetail, RelocateDetail, TOCItem, View } from "../vendor/foliate/view";

export const VIEW_TYPE_BOOKVIEW_EPUB = "bookview-epub";

const FONT_SCALES = [70, 80, 90, 100, 110, 125, 150, 175, 200, 250];
const MIN_FONT_SCALE = FONT_SCALES[0];
const MAX_FONT_SCALE = FONT_SCALES[FONT_SCALES.length - 1];

/** Tables of contents nest arbitrarily deep; stop before a pathological book does. */
const MAX_TOC_DEPTH = 12;

export class BookEpubView extends FileView {
  allowNoFile = false;

  private book: Book | null = null;
  private reader: View | null = null;
  private state: EpubState;
  /** A state that arrived through `setState()` before the book had opened. */
  private pendingState: Partial<EpubState> | null = null;
  private loadToken = 0;
  private lastRelocate: RelocateDetail | null = null;
  /** Whether the book is set vertically, read back off the first rendered section. */
  private vertical = false;
  /** When the wheel last turned a page, so one flick does not turn a dozen. */
  private wheelCooldown = 0;
  /** The last few wheel events and what became of them, for diagnostics. */
  private recentWheel: Record<string, unknown>[] = [];

  private rootEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private outlineEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private messageEl!: HTMLElement;

  private prevBtn!: HTMLElement;
  private nextBtn!: HTMLElement;
  private positionEl!: HTMLElement;
  private fontLabel!: HTMLElement;
  private flowBtn!: HTMLElement;
  private columnsBtn!: HTMLElement;
  private marginBtn!: HTMLElement;
  private marginPanelEl!: HTMLElement;
  private outlineBtn!: HTMLElement;

  private marginPanelOpen = false;
  /** Pulls each margin slider back into line with the setting behind it. */
  private marginSync: (() => void)[] = [];

  private outlineVisible = false;
  /** Maps each TOC entry to its row, so `relocate` can highlight it. */
  private outlineRows = new Map<TOCItem, HTMLElement>();

  constructor(leaf: WorkspaceLeaf, private plugin: BookViewPlugin) {
    super(leaf);
    this.state = plugin.defaultEpubState();
  }

  /** The window this view lives in, which is not `window` in a popout. */
  private get viewWin(): Window {
    return this.containerEl.ownerDocument.defaultView ?? window;
  }

  getViewType(): string {
    return VIEW_TYPE_BOOKVIEW_EPUB;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "EPUB";
  }

  getIcon(): string {
    return "book-open-text";
  }

  // ---------------------------------------------------------------- lifecycle

  async onOpen(): Promise<void> {
    this.buildDom();
  }

  async onClose(): Promise<void> {
    this.teardownBook();
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.buildDom();
    this.teardownBook();
    this.showMessage("Loading " + file.basename + "…");

    const token = ++this.loadToken;
    const remembered = this.plugin.getEpubState(file.path);
    this.state = {
      ...this.plugin.defaultEpubState(),
      ...(remembered ?? {}),
      ...(this.pendingState ?? {}),
    };
    this.pendingState = null;

    let data: ArrayBuffer;
    try {
      data = await this.app.vault.readBinary(file);
    } catch (err) {
      this.showMessage("Could not read the file: " + errorMessage(err));
      return;
    }
    if (token !== this.loadToken) return;

    let book: Book;
    try {
      book = await openEpub(data);
    } catch (err) {
      this.showMessage("Could not open the EPUB: " + errorMessage(err));
      return;
    }
    if (token !== this.loadToken) {
      book.destroy?.();
      return;
    }
    this.book = book;

    try {
      await this.mount(book);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.showMessage("Could not display the EPUB: " + errorMessage(err));
      return;
    }
    if (token !== this.loadToken) return;

    this.hideMessage();
    this.renderOutline();
    this.updateToolbar();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.persistState();
    this.teardownBook();
    await super.onUnloadFile(file);
  }

  getState(): Record<string, unknown> {
    const state = super.getState();
    state.bookviewEpub = { ...this.state };
    return state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const incoming = (state as { bookviewEpub?: Partial<EpubState> } | null)?.bookviewEpub;
    if (incoming) this.pendingState = incoming;
    await super.setState(state, result);
    if (this.reader && this.pendingState) {
      const pending = this.pendingState;
      this.pendingState = null;
      this.state = { ...this.state, ...pending };
      this.applyLayout();
      if (pending.cfi) void this.reader.goTo(pending.cfi).catch(() => undefined);
      this.updateToolbar();
    }
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    if (!this.reader) return;
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Scrolled")
        .setIcon("scroll-text")
        .setChecked(this.state.flow === "scrolled")
        .onClick(() => this.toggleFlow())
    );
    menu.addItem((item) =>
      item
        .setTitle("Two columns")
        .setIcon("columns-2")
        .setChecked(this.state.columns > 1)
        .onClick(() => this.setColumns(this.state.columns > 1 ? 1 : 2))
    );
  }

  /**
   * Builds the renderer and hands it the book.
   *
   * `document.createElement` rather than `createEl()`, and the lint warning that
   * comes with it is deliberate. Custom-element registries are per-window:
   * `foliate-view` is defined in the window the plugin loaded in, and an element
   * built from a popout's document would never upgrade. foliate's own
   * `View.open()` reaches for the global `document` the same way when it builds
   * its renderer, so this matches the library rather than fighting it — and it
   * is why a book opened in a popout window is not supported.
   */
  private async mount(book: Book): Promise<void> {
    const reader = document.createElement("foliate-view") as View;
    this.stageEl.append(reader);
    this.reader = reader;

    reader.addEventListener("load", (evt) => {
      const { doc } = (evt as CustomEvent<LoadDetail>).detail;
      // Key events do not cross an iframe boundary, so every section gets its
      // own handler. It dies with the document.
      doc.addEventListener("keydown", (e) => this.onKeyDown(e));
      doc.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
      // Only the book's own stylesheet knows whether it is set vertically, so
      // the answer has to be read back off a rendered document.
      const mode = doc.defaultView?.getComputedStyle(doc.body).writingMode ?? "";
      const vertical = mode.startsWith("vertical") || mode.startsWith("sideways");
      if (vertical !== this.vertical) {
        this.vertical = vertical;
        // The measure is capped against a different edge of the screen now, so
        // the layout has to be pushed again. Only on a change, so this cannot
        // loop: re-laying out repaginates the section, it does not reload it.
        this.applyLayout();
        this.updateToolbar();
      }
    });
    reader.addEventListener("relocate", (evt) => {
      this.lastRelocate = (evt as CustomEvent<RelocateDetail>).detail;
      this.state.cfi = this.lastRelocate.cfi;
      this.updateToolbar();
      this.updateOutlineHighlight();
      this.persistState();
    });

    await reader.open(book);
    this.applyLayout();

    if (this.state.cfi) {
      try {
        await reader.goTo(this.state.cfi);
        return;
      } catch {
        // A CFI from an older copy of the file may no longer resolve; start over.
      }
    }
    await reader.goToTextStart().catch(() => undefined);
  }

  private teardownBook(): void {
    this.loadToken++;
    this.lastRelocate = null;
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      reader.close();
      reader.remove();
    }
    const book = this.book;
    this.book = null;
    book?.destroy?.();
    this.outlineRows.clear();
    this.setOutlineVisible(false);
    if (this.outlineEl) this.outlineEl.empty();
  }

  // --------------------------------------------------------------------- DOM

  private buildDom(): void {
    if (this.rootEl) return;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("bookview-view-content");

    this.rootEl = container.createDiv({ cls: "bookview-root" });
    this.toolbarEl = this.rootEl.createDiv({ cls: "bookview-toolbar" });
    this.bodyEl = this.rootEl.createDiv({ cls: "bookview-body" });
    this.outlineEl = this.bodyEl.createDiv({ cls: "bookview-outline" });
    this.outlineEl.hide();
    this.stageEl = this.bodyEl.createDiv({ cls: "bookview-stage bookview-stage-epub" });
    this.messageEl = this.stageEl.createDiv({ cls: "bookview-message" });
    this.messageEl.hide();

    this.buildToolbar();

    this.registerDomEvent(this.outlineEl, "click", (evt) => this.onOutlineClick(evt));
    this.registerDomEvent(this.outlineEl, "keydown", (evt) => this.onOutlineKeyDown(evt));
    this.registerDomEvent(this.stageEl, "keydown", (evt) => this.onKeyDown(evt));
    // A click anywhere else dismisses the margins panel. The button's own
    // handler has already run by the time this one sees the event, so a click
    // on the button reads as inside and leaves the toggle it just did alone.
    this.registerDomEvent(container.ownerDocument, "click", (evt) => {
      if (!this.marginPanelOpen) return;
      const target = evt.target as Node | null;
      if (target && (this.marginPanelEl.contains(target) || this.marginBtn.contains(target))) {
        return;
      }
      this.setMarginPanelOpen(false);
    });
    this.registerDomEvent(this.stageEl, "wheel", (evt) => this.onWheel(evt), { passive: false });

    // The book's own light or dark rendering is pinned to the vault's theme, so
    // switching theme has to reach into the iframe.
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyLayout()));
  }

  private buildToolbar(): void {
    const side = this.toolbarEl.createDiv({ cls: "bookview-toolbar-group" });
    this.outlineBtn = this.makeButton(side, "list", "Contents (T)", () => this.toggleOutline());

    const nav = this.toolbarEl.createDiv({ cls: "bookview-toolbar-group" });
    this.prevBtn = this.makeButton(nav, "chevron-left", "Previous page", () => this.turn(-1));
    this.positionEl = nav.createSpan({ cls: "bookview-page-total", text: "—" });
    this.nextBtn = this.makeButton(nav, "chevron-right", "Next page", () => this.turn(1));

    const layout = this.toolbarEl.createDiv({ cls: "bookview-toolbar-group" });
    this.flowBtn = this.makeButton(layout, "book-open", "Scrolled reading", () => this.toggleFlow());
    this.columnsBtn = this.makeButton(layout, "columns-2", "Two columns", () =>
      this.setColumns(this.state.columns > 1 ? 1 : 2)
    );
    this.marginBtn = this.makeButton(layout, "crop", "Margins", () => this.toggleMarginPanel());
    this.marginPanelEl = this.buildMarginPanel(layout);

    const spacer = this.toolbarEl.createDiv({ cls: "bookview-toolbar-spacer" });
    spacer.setAttr("aria-hidden", "true");

    const type = this.toolbarEl.createDiv({ cls: "bookview-toolbar-group" });
    this.makeButton(type, "zoom-out", "Smaller type (-)", () => this.stepFontScale(-1));
    this.fontLabel = type.createSpan({ cls: "bookview-zoom-label", text: "100%" });
    setTooltip(this.fontLabel, "Type size");
    this.makeButton(type, "zoom-in", "Larger type (+)", () => this.stepFontScale(1));
  }

  private makeButton(
    parent: HTMLElement,
    icon: string,
    tooltip: string,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createEl("button", { cls: "bookview-btn clickable-icon" });
    setIcon(btn, icon);
    setTooltip(btn, tooltip);
    btn.setAttr("aria-label", tooltip);
    this.registerDomEvent(btn, "click", (evt) => {
      evt.preventDefault();
      onClick();
    });
    return btn;
  }

  /**
   * The margins again, on the toolbar. What they should be depends on the book
   * and on how wide the pane happens to be right now, which is a judgement made
   * while reading and not one worth a trip to the settings tab. Both places
   * write the same setting, so every open book follows.
   */
  private buildMarginPanel(parent: HTMLElement): HTMLElement {
    const panel = parent.createDiv({ cls: "bookview-margin-panel" });
    panel.hide();
    this.makeMarginSlider(
      panel,
      "Top and bottom",
      () => this.plugin.settings.epubVerticalMargin,
      (v) => (this.plugin.settings.epubVerticalMargin = v)
    );
    this.makeMarginSlider(
      panel,
      "Left and right",
      () => this.plugin.settings.epubHorizontalMargin,
      (v) => (this.plugin.settings.epubHorizontalMargin = v)
    );
    // Escape closes it, and puts the focus back where it can turn pages.
    this.registerDomEvent(panel, "keydown", (evt) => {
      if (evt.key !== "Escape") return;
      evt.preventDefault();
      evt.stopPropagation();
      this.setMarginPanelOpen(false);
    });
    return panel;
  }

  private makeMarginSlider(
    parent: HTMLElement,
    label: string,
    get: () => number,
    set: (value: number) => void
  ): void {
    const row = parent.createDiv({ cls: "bookview-margin-row" });
    row.createSpan({ cls: "bookview-margin-label", text: label });
    // `slider` is Obsidian's own class for a range input, so this is the same
    // control the settings tab draws.
    const slider = row.createEl("input", { cls: "slider bookview-margin-slider" });
    slider.type = "range";
    slider.min = "0";
    slider.max = String(EPUB_MARGIN_MAX);
    slider.step = String(EPUB_MARGIN_STEP);
    slider.setAttr("aria-label", label + " margin");
    const readout = row.createSpan({ cls: "bookview-margin-value" });

    const sync = () => {
      slider.value = String(get());
      readout.setText(get() + " px");
    };
    sync();
    this.marginSync.push(sync);

    // Dragging re-lays out every open book as it goes; the setting is only
    // written once the drag ends, rather than at every pixel along the way.
    this.registerDomEvent(slider, "input", () => {
      set(Number(slider.value));
      readout.setText(slider.value + " px");
      this.plugin.refreshOpenViews();
    });
    this.registerDomEvent(slider, "change", () => void this.plugin.saveSettings());
  }

  /** The toolbar button's action, and the command palette's way to the same. */
  toggleMarginPanel(): void {
    this.setMarginPanelOpen(!this.marginPanelOpen);
  }

  private setMarginPanelOpen(open: boolean): void {
    this.marginPanelOpen = open;
    // The settings tab writes the same numbers, so the sliders are only true
    // as of the moment the panel opens.
    if (open) for (const sync of this.marginSync) sync();
    if (open) this.marginPanelEl.show();
    else this.marginPanelEl.hide();
    this.marginBtn.toggleClass("is-active", open);
  }

  private showMessage(text: string): void {
    this.messageEl.setText(text);
    this.messageEl.show();
  }

  private hideMessage(): void {
    this.messageEl.setText("");
    this.messageEl.hide();
  }

  // ------------------------------------------------------------------ layout

  /** Pushes the whole of {@link state} that the renderer cares about into it. */
  private applyLayout(): void {
    const reader = this.reader;
    if (!reader) return;
    const renderer = reader.renderer;
    renderer.setAttribute("flow", this.state.flow);
    renderer.setAttribute("gap", this.plugin.settings.epubGap + "%");
    renderer.setAttribute("margin", this.plugin.settings.epubVerticalMargin + "px");
    renderer.setAttribute("max-column-count", String(this.state.columns));
    renderer.setAttribute("max-inline-size", this.maxMeasure() + "px");
    renderer.setAttribute("max-block-size", this.plugin.settings.epubMaxBlockSize + "px");
    renderer.setStyles?.(this.bookStyles());
    this.applySideMargin(reader);

    this.stageEl.toggleClass(
      "is-inverted",
      this.isDarkTheme() && this.plugin.settings.invertInDarkMode
    );
  }

  /**
   * The cap on the measure: the width of a column in a horizontally set book,
   * the height of the text in a vertically set one. One attribute, but two
   * readings of it far enough apart that each writing mode keeps its own
   * setting — a pane is much wider than it is tall, so the number that leaves a
   * horizontal book readable leaves a vertical one stranded in white.
   */
  private maxMeasure(): number {
    const settings = this.plugin.settings;
    return this.vertical ? settings.epubMaxVerticalHeight : settings.epubMaxLineLength;
  }

  /**
   * Insets the renderer itself, which is how the left and right margins are
   * kept: the paginator has an attribute for the top and bottom margin but
   * none for the sides, where it leaves whatever the column gap works out to.
   * The paginator sizes itself from its own content box and re-paginates when
   * that box changes, so padding on it is simply a smaller page.
   *
   * A fixed-layout book is drawn by a different renderer, one that is not
   * box-sized for this and would only overflow, so it is left alone.
   */
  private applySideMargin(reader: View): void {
    const margin = reader.isFixedLayout ? 0 : this.plugin.settings.epubHorizontalMargin;
    reader.renderer.style.paddingLeft = margin + "px";
    reader.renderer.style.paddingRight = margin + "px";
  }

  /**
   * A stylesheet laid over the book's own. Kept deliberately thin: an EPUB
   * carries its own typography, and a reader that overrides it wholesale ruins
   * exactly the books BookView exists for.
   */
  private bookStyles(): string {
    // The book renders in an iframe, which would otherwise take its light or
    // dark cue from the operating system and ignore the vault's theme entirely.
    const scheme = this.isDarkTheme() ? "dark" : "light";
    return [
      "html { font-size: " + this.state.fontScale + "%; color-scheme: " + scheme + "; }",
      "p, li, blockquote, dd { line-height: " + this.plugin.settings.epubLineHeight + "; }",
      "pre { white-space: pre-wrap !important; }",
    ].join("\n");
  }

  private isDarkTheme(): boolean {
    return this.viewWin.document.body.hasClass("theme-dark");
  }

  // ----------------------------------------------------------------- toolbar

  private updateToolbar(): void {
    const rtl = this.book?.dir === "rtl";
    setIcon(this.prevBtn, rtl ? "chevron-right" : "chevron-left");
    setIcon(this.nextBtn, rtl ? "chevron-left" : "chevron-right");
    setTooltip(this.prevBtn, rtl ? "Previous page (→)" : "Previous page (←)");
    setTooltip(this.nextBtn, rtl ? "Next page (←)" : "Next page (→)");

    const at = this.lastRelocate;
    const page = at?.pageItem?.label?.trim();
    // A reflowable book has no pages of its own, so these are the renderer's
    // even divisions of the text. Both counters it reports are zero-based, and
    // both are NaN until the leaf has a size — a background tab, or a pane still
    // opening — because there is no laid-out column to measure a position in.
    const located = at && Number.isFinite(at.location.current);
    if (page) {
      this.positionEl.setText(page);
      setTooltip(this.positionEl, "Page " + page + " of the printed edition");
    } else if (at && located) {
      this.positionEl.setText(at.location.current + 1 + " / " + at.location.total);
      setTooltip(
        this.positionEl,
        "Location " + (at.location.current + 1) + " of " + at.location.total +
          " — chapter " + (at.section.current + 1) + " of " + at.section.total +
          ", " + Math.round(at.fraction * 100) + "% read"
      );
    } else {
      this.positionEl.setText("—");
      setTooltip(this.positionEl, "Position");
    }

    this.fontLabel.setText(this.state.fontScale + "%");
    this.flowBtn.toggleClass("is-active", this.state.flow === "scrolled");
    this.columnsBtn.toggleClass("is-active", this.state.columns > 1);
    // Vertical writing fills the width whatever this says, so the control is
    // taken away rather than left there lying.
    this.columnsBtn.toggleClass("is-disabled", this.isVertical());
    this.outlineBtn.toggleClass("is-active", this.outlineVisible);
  }

  // -------------------------------------------------------------- navigation

  /** `delta > 0` means forward in reading order, whichever way the book is bound. */
  turn(delta: number): void {
    const reader = this.reader;
    if (!reader) return;
    void (delta > 0 ? reader.next() : reader.prev()).catch(() => undefined);
  }

  /** Moves in a screen direction; the renderer maps it through the binding. */
  turnTowards(side: "left" | "right"): void {
    const reader = this.reader;
    if (!reader) return;
    void (side === "left" ? reader.goLeft() : reader.goRight()).catch(() => undefined);
  }

  setFlow(flow: FlowMode): void {
    if (this.state.flow === flow) return;
    this.state.flow = flow;
    this.applyLayout();
    this.updateToolbar();
    this.persistState();
  }

  toggleFlow(): void {
    this.setFlow(this.state.flow === "paginated" ? "scrolled" : "paginated");
  }

  setColumns(columns: number): void {
    const next = Math.max(1, Math.min(2, Math.round(columns)));
    if (this.state.columns === next) return;
    this.state.columns = next;
    this.applyLayout();
    this.updateToolbar();
    this.persistState();
  }

  setFontScale(scale: number): void {
    const next = Math.max(MIN_FONT_SCALE, Math.min(MAX_FONT_SCALE, Math.round(scale)));
    if (this.state.fontScale === next) return;
    this.state.fontScale = next;
    this.applyLayout();
    this.updateToolbar();
    this.persistState();
  }

  stepFontScale(direction: number): void {
    const current = this.state.fontScale;
    const next =
      direction > 0
        ? FONT_SCALES.find((s) => s > current) ?? MAX_FONT_SCALE
        : [...FONT_SCALES].reverse().find((s) => s < current) ?? MIN_FONT_SCALE;
    this.setFontScale(next);
  }

  hasBook(): boolean {
    return !!this.reader;
  }

  /** Re-applies the settings-derived half of the layout, after one changed. */
  refreshLayout(): void {
    this.applyLayout();
  }

  /** True for a book set with `writing-mode: vertical-rl`, as Japanese prose is. */
  isVertical(): boolean {
    return this.vertical;
  }

  /**
   * Everything worth knowing when a book opens but does not appear. Gathered
   * here rather than typed into a console by hand, because the interesting
   * measurements are inside the renderer's closed shadow root and the book's
   * own iframe, which are awkward to reach from outside.
   */
  collectDiagnostics(): Record<string, unknown> {
    const report: Record<string, unknown> = {
      file: this.file?.path ?? null,
      state: { ...this.state },
      vertical: this.vertical,
      theme: this.isDarkTheme() ? "dark" : "light",
      book: this.book
        ? {
            dir: this.book.dir ?? null,
            layout: this.book.rendition?.layout ?? null,
            sections: this.book.sections.length,
            toc: this.book.toc?.length ?? 0,
          }
        : null,
      position: this.lastRelocate
        ? {
            fraction: this.lastRelocate.fraction,
            location: this.lastRelocate.location,
            section: this.lastRelocate.section,
          }
        : null,
      stage: box(this.stageEl),
      wheel: this.recentWheel.slice(),
    };

    const reader = this.reader;
    if (!reader) return { ...report, error: "no renderer" };
    report.view = box(reader);
    report.renderer = { tag: reader.renderer?.tagName?.toLowerCase() ?? null, ...box(reader.renderer) };

    let contents: { doc: Document; index: number }[] = [];
    try {
      contents = reader.renderer.getContents();
    } catch (err) {
      report.contentsError = errorMessage(err);
    }
    report.loadedSections = contents.length;

    const doc = contents[0]?.doc;
    if (!doc?.defaultView) return report;
    const win = doc.defaultView;
    const style = (el: Element) => win.getComputedStyle(el);

    const frame = win.frameElement;
    report.iframe = frame
      ? {
          ...box(frame),
          display: style(frame).display,
          visibility: style(frame).visibility,
          opacity: style(frame).opacity,
        }
      : "no frameElement";

    const html = style(doc.documentElement);
    report.documentElement = {
      width: html.width,
      height: html.height,
      writingMode: html.writingMode,
      columnWidth: html.columnWidth,
      transform: html.transform,
      overflow: html.overflow,
      scroll: [doc.documentElement.scrollLeft, doc.documentElement.scrollTop],
      scrollSize: [doc.documentElement.scrollWidth, doc.documentElement.scrollHeight],
    };

    if (doc.body) {
      const body = style(doc.body);
      report.body = {
        ...box(doc.body),
        color: body.color,
        backgroundColor: body.backgroundColor,
        visibility: body.visibility,
        opacity: body.opacity,
        fontFamily: body.fontFamily,
        fontSize: body.fontSize,
        text: doc.body.textContent?.trim().slice(0, 60) ?? "",
      };
      const first = doc.body.querySelector("p, h1, h2, div, img");
      report.firstElement = first
        ? { tag: first.tagName.toLowerCase(), ...box(first), color: style(first).color }
        : null;
    }

    report.markup = {
      stylesheetLinks: doc.querySelectorAll("link[rel~='stylesheet']").length,
      inlineStyles: doc.querySelectorAll("style").length,
      csp: !!doc.querySelector('meta[http-equiv="Content-Security-Policy"]'),
    };
    return report;
  }

  getEpubState(): Readonly<EpubState> {
    return this.state;
  }

  /**
   * The wheel turns pages, the way it does in the PDF view. Nothing in the
   * renderer handles it — foliate only listens for touch — and a wheel event
   * over the book fires inside its iframe, so this is attached to each section
   * as it loads as well as to the stage around it.
   */
  private onWheel(evt: WheelEvent): void {
    if (evt.ctrlKey || evt.metaKey) {
      evt.preventDefault();
      this.stepFontScale(evt.deltaY < 0 ? 1 : -1);
      return;
    }
    // Scrolled reading is scrolling; leave the wheel to do what it says.
    if (this.state.flow === "scrolled") {
      this.noteWheel(evt, "scrolled: left alone");
      return;
    }

    // A sideways wheel goes through the binding — `goLeft` is "next" in a
    // right-bound book — while a vertical one keeps the plain down-is-onward
    // sense whichever way the book runs.
    const horizontal = Math.abs(evt.deltaX) > Math.abs(evt.deltaY);
    const delta = horizontal ? evt.deltaX : evt.deltaY;
    // A wheel may report its delta in lines or pages rather than pixels, and one
    // line is a perfectly ordinary `1`. Judging that against a pixel threshold
    // would throw the event away.
    const threshold = evt.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 4 : 0.5;
    if (Math.abs(delta) < threshold) {
      this.noteWheel(evt, "below threshold");
      return;
    }

    // A single flick of a trackpad is a burst of events, and without this it
    // would turn a dozen pages.
    const now = Date.now();
    evt.preventDefault();
    if (now - this.wheelCooldown < 220) {
      this.noteWheel(evt, "within cooldown");
      return;
    }
    this.wheelCooldown = now;

    if (horizontal) {
      this.noteWheel(evt, delta > 0 ? "goRight" : "goLeft");
      this.turnTowards(delta > 0 ? "right" : "left");
    } else {
      this.noteWheel(evt, delta > 0 ? "next" : "prev");
      this.turn(delta > 0 ? 1 : -1);
    }
  }

  /** Keeps the last few wheel events, so `collectDiagnostics` can show them. */
  private noteWheel(evt: WheelEvent, outcome: string): void {
    // The book lives in an iframe, so its elements come from another realm and
    // `instanceof Element` is false for every one of them. Ask for the tag.
    const tag = (evt.target as { tagName?: unknown } | null)?.tagName;
    this.recentWheel.push({
      dx: Math.round(evt.deltaX * 100) / 100,
      dy: Math.round(evt.deltaY * 100) / 100,
      mode: ["pixel", "line", "page"][evt.deltaMode] ?? String(evt.deltaMode),
      on: typeof tag === "string" ? tag.toLowerCase() : "(not an element)",
      inBook: evt.view !== this.viewWin,
      outcome,
    });
    if (this.recentWheel.length > 8) this.recentWheel.shift();
  }

  private onKeyDown(evt: KeyboardEvent): void {
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
    switch (evt.key) {
      case "ArrowLeft":
        this.turnTowards("left");
        break;
      case "ArrowRight":
        this.turnTowards("right");
        break;
      case "ArrowUp":
      case "PageUp":
        this.turn(-1);
        break;
      case "ArrowDown":
      case "PageDown":
        this.turn(1);
        break;
      case " ":
        this.turn(evt.shiftKey ? -1 : 1);
        break;
      case "+":
      case "=":
        this.stepFontScale(1);
        break;
      case "-":
        this.stepFontScale(-1);
        break;
      default:
        return;
    }
    evt.preventDefault();
  }

  // ------------------------------------------------------------------ contents

  toggleOutline(): void {
    this.setOutlineVisible(!this.outlineVisible);
  }

  private setOutlineVisible(visible: boolean): void {
    this.outlineVisible = visible;
    if (!this.outlineEl) return;
    if (visible) this.outlineEl.show();
    else this.outlineEl.hide();
    if (this.outlineBtn) this.outlineBtn.toggleClass("is-active", visible);
    if (visible) this.updateOutlineHighlight();
  }

  private renderOutline(): void {
    if (!this.outlineEl) return;
    this.outlineEl.empty();
    this.outlineRows.clear();
    const toc = this.book?.toc ?? [];
    if (!toc.length) {
      this.outlineEl.createDiv({
        cls: "bookview-outline-empty",
        text: "This EPUB has no table of contents.",
      });
      return;
    }
    this.renderOutlineEntries(toc, this.outlineEl.createDiv({ cls: "bookview-outline-list" }), 0);
    this.updateOutlineHighlight();
  }

  private renderOutlineEntries(entries: TOCItem[], parent: HTMLElement, depth: number): void {
    if (depth > MAX_TOC_DEPTH) return;
    for (const entry of entries) {
      // Obsidian's own tree markup, matching the PDF view's outline panel.
      const item = parent.createDiv({ cls: "bookview-outline-item tree-item" });
      const row = item.createDiv({ cls: "bookview-outline-row tree-item-self" });
      row.style.setProperty("--bookview-outline-depth", String(depth));

      const children = entry.subitems ?? [];
      if (children.length) {
        const twisty = row.createDiv({
          cls: "bookview-outline-twisty tree-item-icon collapse-icon",
        });
        setIcon(twisty, "chevron-down");
        twisty.setAttr("aria-label", "Collapse or expand");
        setTooltip(twisty, "Collapse or expand");
      } else {
        row.createDiv({ cls: "bookview-outline-indent" });
      }

      const label = entry.label?.trim() || "Untitled";
      row.createDiv({ cls: "bookview-outline-title tree-item-inner", text: label });
      if (entry.href) {
        row.addClass("is-clickable");
        row.dataset.href = entry.href;
        row.setAttr("role", "button");
        row.tabIndex = 0;
        setTooltip(row, label);
        // Kept by identity, because `relocate` hands back the very same object.
        this.outlineRows.set(entry, row);
      } else {
        row.addClass("is-disabled");
      }

      if (children.length) {
        const childEl = item.createDiv({ cls: "bookview-outline-children" });
        this.renderOutlineEntries(children, childEl, depth + 1);
      }
    }
  }

  private onOutlineClick(evt: MouseEvent): void {
    const target = evt.target as Element | null;
    const twisty = target?.closest(".bookview-outline-twisty");
    if (twisty) {
      twisty.closest(".bookview-outline-item")?.classList.toggle("is-collapsed");
      return;
    }
    this.followOutlineRow(target);
  }

  private onOutlineKeyDown(evt: KeyboardEvent): void {
    if (evt.key !== "Enter" && evt.key !== " ") return;
    const target = evt.target as Element | null;
    if (!target?.closest(".bookview-outline-row")) return;
    evt.preventDefault();
    this.followOutlineRow(target);
  }

  private followOutlineRow(target: Element | null): void {
    const href = target?.closest<HTMLElement>(".bookview-outline-row")?.dataset.href;
    if (!href || !this.reader) return;
    void this.reader.goTo(href).catch(() => undefined);
  }

  /** Marks the entry `relocate` reported for the position on screen. */
  private updateOutlineHighlight(): void {
    if (!this.outlineRows.size) return;
    const current = this.lastRelocate?.tocItem ?? null;
    for (const [entry, el] of this.outlineRows) el.toggleClass("is-current", entry === current);
  }

  private persistState(): void {
    if (!this.file || !this.reader) return;
    this.plugin.saveEpubState(this.file.path, this.state);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An element's size and where it sits, rounded to whole pixels. */
function box(el: Element | null | undefined): Record<string, unknown> {
  if (!el) return { missing: true };
  const rect = el.getBoundingClientRect();
  return {
    size: [el.clientWidth, el.clientHeight],
    rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
  };
}
