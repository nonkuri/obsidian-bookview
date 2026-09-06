import { FileView, Menu, Notice, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { ViewStateResult } from "obsidian";
import type BookViewPlugin from "./main";
import { loadPdfDocument, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "./pdfjs";
import type { DocState, FitMode, SpreadMode } from "./types";

export const VIEW_TYPE_BOOKVIEW_PDF = "bookview-pdf";

const ZOOM_STEPS = [
  0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8,
];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** A single unit of display: one page, or the two halves of a spread. */
type Spread = number[];

export class BookPdfView extends FileView {
  allowNoFile = false;

  private doc: PDFDocumentProxy | null = null;
  private loadingTask: ReturnType<typeof loadPdfDocument> | null = null;
  private docState: DocState;
  /** State restored from the workspace, applied once the document is loaded. */
  private pendingState: Partial<DocState> | null = null;

  private spreads: Spread[] = [];
  private renderToken = 0;
  private activeTasks: RenderTask[] = [];
  private renderedPages: PDFPageProxy[] = [];
  private renderedScale = 1;

  private rootEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private spreadEl!: HTMLElement;
  private messageEl!: HTMLElement;

  private pageInput!: HTMLInputElement;
  private pageTotalEl!: HTMLElement;
  private zoomLabel!: HTMLElement;
  private prevBtn!: HTMLElement;
  private nextBtn!: HTMLElement;
  private spreadBtn!: HTMLElement;
  private coverBtn!: HTMLElement;
  private rtlBtn!: HTMLElement;
  private fitPageBtn!: HTMLElement;
  private fitWidthBtn!: HTMLElement;

  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private lastViewportKey = "";
  private wheelCooldown = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: BookViewPlugin) {
    super(leaf);
    this.docState = plugin.defaultDocState();
  }

  getViewType(): string {
    return VIEW_TYPE_BOOKVIEW_PDF;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "PDF";
  }

  getIcon(): string {
    return "book-open";
  }

  // ---------------------------------------------------------------- lifecycle

  async onOpen(): Promise<void> {
    this.buildDom();
  }

  async onClose(): Promise<void> {
    this.teardownDocument();
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.buildDom();
    this.teardownDocument();
    this.showMessage(file.basename + " を読み込み中…");

    const remembered = this.plugin.getFileState(file.path);
    const base = this.plugin.defaultDocState();
    this.docState = { ...base, ...(remembered ?? {}), ...(this.pendingState ?? {}) };
    const hasExplicitState = !!remembered || !!this.pendingState;
    this.pendingState = null;

    let data: ArrayBuffer;
    try {
      data = await this.app.vault.readBinary(file);
    } catch (err) {
      this.showMessage("ファイルを読み込めませんでした: " + errorMessage(err));
      return;
    }
    if (this.file !== file) return;

    const task = loadPdfDocument(data);
    this.loadingTask = task;
    try {
      const doc = await task.promise;
      if (this.loadingTask !== task) {
        void doc.destroy();
        return;
      }
      this.doc = doc;
      if (this.plugin.settings.autoDetect && !hasExplicitState) {
        await this.applyDocumentPreferences(doc);
      }
      this.docState.page = clamp(Math.round(this.docState.page) || 1, 1, doc.numPages);
      this.hideMessage();
      this.rebuildSpreads();
      this.updateToolbar();
      await this.render();
    } catch (err) {
      if (this.loadingTask !== task) return;
      this.showMessage("PDF を開けませんでした: " + errorMessage(err));
    }
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.persistState();
    this.teardownDocument();
    await super.onUnloadFile(file);
  }

  getState(): Record<string, unknown> {
    const state = super.getState() as Record<string, unknown>;
    state.bookview = { ...this.docState };
    return state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const incoming = (state as { bookview?: Partial<DocState> } | null)?.bookview;
    if (incoming) this.pendingState = incoming;
    await super.setState(state, result);
    if (this.doc && this.pendingState) {
      this.docState = { ...this.docState, ...this.pendingState };
      this.pendingState = null;
      this.rebuildSpreads();
      this.updateToolbar();
      void this.render();
    }
  }

  onResize(): void {
    this.scheduleRerender();
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    if (!this.doc) return;
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("見開き表示 / Two-page spread")
        .setIcon("book-open")
        .setChecked(this.docState.spread === "spread")
        .onClick(() => this.toggleSpread())
    );
    menu.addItem((item) =>
      item
        .setTitle("右綴じ / Right-to-left binding")
        .setIcon("arrow-left-right")
        .setChecked(this.docState.rtl)
        .onClick(() => this.toggleRtl())
    );
    menu.addItem((item) =>
      item
        .setTitle("表紙を表示 / Show cover page")
        .setIcon("book")
        .setChecked(this.docState.cover)
        .onClick(() => this.toggleCover())
    );
  }

  private teardownDocument(): void {
    this.cancelRenders();
    this.renderToken++;
    const task = this.loadingTask;
    this.loadingTask = null;
    const doc = this.doc;
    this.doc = null;
    this.spreads = [];
    this.renderedPages = [];
    if (task) void task.destroy().catch(() => undefined);
    else if (doc) void doc.destroy().catch(() => undefined);
    if (this.spreadEl) this.spreadEl.empty();
  }

  private cancelRenders(): void {
    for (const task of this.activeTasks) {
      try {
        task.cancel();
      } catch {
        /* already finished */
      }
    }
    this.activeTasks = [];
  }

  // --------------------------------------------------------------------- DOM

  private buildDom(): void {
    if (this.rootEl) return;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("bookview-view-content");

    this.rootEl = container.createDiv({ cls: "bookview-root" });
    this.toolbarEl = this.rootEl.createDiv({ cls: "bookview-toolbar" });
    this.stageEl = this.rootEl.createDiv({ cls: "bookview-stage" });
    this.stageEl.tabIndex = 0;
    this.spreadEl = this.stageEl.createDiv({ cls: "bookview-spread" });
    this.messageEl = this.stageEl.createDiv({ cls: "bookview-message" });
    this.messageEl.hide();

    this.buildToolbar();

    this.registerDomEvent(this.stageEl, "keydown", (evt) => this.onKeyDown(evt));
    this.registerDomEvent(this.stageEl, "wheel", (evt) => this.onWheel(evt), { passive: false });
    this.registerDomEvent(this.stageEl, "mousedown", (evt) => {
      if (evt.button === 0) this.stageEl.focus();
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.scheduleRerender());
      this.resizeObserver.observe(this.stageEl);
      this.register(() => this.resizeObserver?.disconnect());
    }
    this.register(() => {
      if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    });
  }

  private buildToolbar(): void {
    const nav = this.toolbarEl.createDiv({ cls: "bookview-toolbar-group" });
    this.prevBtn = this.makeButton(nav, "chevron-left", "前のページ", () => this.turn(-1));
    const pageBox = nav.createDiv({ cls: "bookview-pagebox" });
    this.pageInput = pageBox.createEl("input", { cls: "bookview-page-input", type: "text" });
    this.pageInput.inputMode = "numeric";
    this.pageTotalEl = pageBox.createSpan({ cls: "bookview-page-total", text: "/ 0" });
    this.nextBtn = this.makeButton(nav, "chevron-right", "次のページ", () => this.turn(1));

    this.registerDomEvent(this.pageInput, "keydown", (evt) => {
      evt.stopPropagation();
      if (evt.key === "Enter") {
        this.commitPageInput();
        this.stageEl.focus();
      } else if (evt.key === "Escape") {
        this.updateToolbar();
        this.stageEl.focus();
      }
    });
    this.registerDomEvent(this.pageInput, "blur", () => this.commitPageInput());
    this.registerDomEvent(this.pageInput, "focus", () => this.pageInput.select());

    const layout = this.toolbarEl.createDiv({ cls: "bookview-toolbar-group" });
    this.spreadBtn = this.makeButton(layout, "book-open", "見開き表示 (S)", () => this.toggleSpread());
    this.coverBtn = this.makeButton(layout, "book", "表紙を表示 (C)", () => this.toggleCover());
    this.rtlBtn = this.makeButton(layout, "arrow-left", "右綴じ (R)", () => this.toggleRtl());

    const spacer = this.toolbarEl.createDiv({ cls: "bookview-toolbar-spacer" });
    spacer.setAttr("aria-hidden", "true");

    const zoom = this.toolbarEl.createDiv({ cls: "bookview-toolbar-group" });
    this.makeButton(zoom, "zoom-out", "縮小 (-)", () => this.stepZoom(-1));
    this.zoomLabel = zoom.createEl("button", { cls: "bookview-zoom-label", text: "100%" });
    setTooltip(this.zoomLabel, "拡大率");
    this.registerDomEvent(this.zoomLabel, "click", (evt) => this.openZoomMenu(evt));
    this.makeButton(zoom, "zoom-in", "拡大 (+)", () => this.stepZoom(1));
    this.fitPageBtn = this.makeButton(zoom, "maximize", "全体を表示 (0)", () => this.setFit("page"));
    this.fitWidthBtn = this.makeButton(zoom, "move-horizontal", "幅に合わせる (W)", () =>
      this.setFit("width")
    );

    const extra = this.toolbarEl.createDiv({ cls: "bookview-toolbar-group" });
    this.makeButton(extra, "rotate-cw", "右に回転", () => this.rotate(90));
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
      this.stageEl.focus();
    });
    return btn;
  }

  private showMessage(text: string): void {
    if (!this.spreadEl) return;
    this.spreadEl.empty();
    this.messageEl.setText(text);
    this.messageEl.show();
  }

  private hideMessage(): void {
    this.messageEl.hide();
  }

  // ------------------------------------------------------------ spread model

  /**
   * Builds the list of spreads for the current layout.
   *
   * With `cover` on, page 1 stands alone and pairing restarts at page 2 — the
   * same thing Acrobat's "Show Cover Page in Two Page View" does, and what makes
   * the page numbers of a real book fall on the correct sides.
   */
  private rebuildSpreads(): void {
    const total = this.doc ? this.doc.numPages : 0;
    const spreads: Spread[] = [];
    if (this.docState.spread === "single") {
      for (let p = 1; p <= total; p++) spreads.push([p]);
    } else {
      let p = 1;
      if (this.docState.cover && total >= 1) {
        spreads.push([1]);
        p = 2;
      }
      for (; p <= total; p += 2) {
        spreads.push(p + 1 <= total ? [p, p + 1] : [p]);
      }
    }
    this.spreads = spreads;
  }

  private get spreadIndex(): number {
    const page = this.docState.page;
    for (let i = 0; i < this.spreads.length; i++) {
      if (this.spreads[i].indexOf(page) !== -1) return i;
    }
    return this.spreads.length ? clamp(page - 1, 0, this.spreads.length - 1) : 0;
  }

  private currentSpread(): Spread {
    return this.spreads[this.spreadIndex] ?? [];
  }

  /**
   * Where a lone page sits inside an otherwise two-up spread.
   *
   * The cover is a recto, so it takes the leading slot (the right half of a
   * right-bound book, the left half of a left-bound one). A lone final page is
   * a verso and takes the trailing slot.
   */
  private lonePageSide(index: number): "leading" | "trailing" | null {
    if (this.docState.spread !== "spread") return null;
    if (!this.plugin.settings.alignSinglePages) return null;
    const spread = this.spreads[index];
    if (!spread || spread.length !== 1) return null;
    if (this.spreads.length === 1) return null;
    return index === 0 ? "leading" : "trailing";
  }

  // ------------------------------------------------------------------ render

  private scheduleRerender(): void {
    if (!this.doc) return;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      if (this.stageEl.clientWidth === 0 || this.stageEl.clientHeight === 0) return;
      const key = this.stageEl.clientWidth + "x" + this.stageEl.clientHeight;
      if (key === this.lastViewportKey) return;
      this.lastViewportKey = key;
      // A fixed zoom produces the same canvas whatever the viewport does.
      if (this.docState.fit === "custom") return;
      void this.render();
    }, 120);
  }

  private async render(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const token = ++this.renderToken;
    this.cancelRenders();

    const spread = this.currentSpread();
    if (!spread.length) return;

    let pages: PDFPageProxy[];
    try {
      pages = await Promise.all(spread.map((n) => doc.getPage(n)));
    } catch (err) {
      if (token === this.renderToken) {
        this.showMessage("ページを読み込めませんでした: " + errorMessage(err));
      }
      return;
    }
    if (token !== this.renderToken) return;

    const rotation = this.docState.rotation;
    const viewports = pages.map((p) => p.getViewport({ scale: 1, rotation }));
    const lone = this.lonePageSide(this.spreadIndex);
    const slots = viewports.length + (lone ? 1 : 0);
    const gap = slots > 1 ? this.plugin.settings.spreadGap : 0;

    let contentWidth = viewports.reduce((sum, v) => sum + v.width, 0);
    if (lone) contentWidth += viewports[0].width; // the blank half mirrors the real page
    const contentHeight = Math.max.apply(null, viewports.map((v) => v.height));
    const totalWidth = contentWidth + gap * (slots - 1);

    // Emptied first so the stage is measured without the previous spread's
    // scrollbars, which would otherwise shrink the fit and oscillate.
    this.spreadEl.empty();
    const scale = this.computeScale(totalWidth, contentHeight);
    this.renderedScale = scale;

    const dpr = Math.min(window.devicePixelRatio || 1, this.plugin.settings.maxPixelRatio);

    this.spreadEl.style.gap = gap + "px";
    this.spreadEl.toggleClass("is-rtl", this.docState.rtl && slots > 1);
    this.spreadEl.toggleClass("is-shadow", this.plugin.settings.pageShadow);
    this.spreadEl.toggleClass("is-inverted", this.plugin.settings.invertInDarkMode);

    const makeSpacer = () => {
      const el = this.spreadEl.createDiv({ cls: "bookview-page bookview-page-spacer" });
      el.style.width = Math.floor(viewports[0].width * scale) + "px";
      el.style.height = Math.floor(viewports[0].height * scale) + "px";
    };

    if (lone === "leading") makeSpacer();

    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < pages.length; i++) {
      const vp = viewports[i];
      const wrapper = this.spreadEl.createDiv({ cls: "bookview-page" });
      wrapper.dataset.page = String(spread[i]);
      const canvas = wrapper.createEl("canvas", { cls: "bookview-canvas" });
      canvas.style.width = Math.floor(vp.width * scale) + "px";
      canvas.style.height = Math.floor(vp.height * scale) + "px";
      canvas.width = Math.max(1, Math.floor(vp.width * scale * dpr));
      canvas.height = Math.max(1, Math.floor(vp.height * scale * dpr));
      canvases.push(canvas);
    }

    if (lone === "trailing") makeSpacer();

    const tasks: RenderTask[] = [];
    for (let i = 0; i < pages.length; i++) {
      const ctx = canvases[i].getContext("2d");
      if (!ctx) continue;
      tasks.push(
        pages[i].render({
          canvasContext: ctx,
          viewport: pages[i].getViewport({ scale: scale * dpr, rotation }),
        })
      );
    }
    this.activeTasks = tasks;

    try {
      await Promise.all(tasks.map((t) => t.promise));
    } catch (err) {
      if (!isRenderCancelled(err) && token === this.renderToken) {
        console.error("BookView: page render failed", err);
      }
      return;
    } finally {
      if (token === this.renderToken) this.activeTasks = [];
    }

    if (token !== this.renderToken) return;

    // Release the pages we have moved away from. Page proxies are cached per
    // document, so cleaning up eagerly would tear down resources that a newer
    // render of the same page is still using.
    for (const page of this.renderedPages) {
      if (pages.indexOf(page) === -1) page.cleanup();
    }
    this.renderedPages = pages;

    this.hideMessage();
    this.updateToolbar();
    this.stageEl.scrollTop = 0;
    this.lastViewportKey = this.stageEl.clientWidth + "x" + this.stageEl.clientHeight;
    this.persistState();
  }

  private computeScale(totalWidth: number, contentHeight: number): number {
    if (this.docState.fit === "custom") return clamp(this.docState.zoom, MIN_ZOOM, MAX_ZOOM);
    const style = window.getComputedStyle(this.stageEl);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const availWidth = Math.max(40, this.stageEl.clientWidth - padX);
    const availHeight = Math.max(40, this.stageEl.clientHeight - padY);
    const byWidth = availWidth / totalWidth;
    const scale =
      this.docState.fit === "width" ? byWidth : Math.min(byWidth, availHeight / contentHeight);
    return clamp(scale, MIN_ZOOM, MAX_ZOOM);
  }

  // ----------------------------------------------------------------- toolbar

  private updateToolbar(): void {
    const total = this.doc ? this.doc.numPages : 0;
    const spread = this.currentSpread();
    this.pageTotalEl.setText("/ " + total);
    if (document.activeElement !== this.pageInput) {
      this.pageInput.value =
        spread.length > 1
          ? spread[0] + "–" + spread[spread.length - 1]
          : String(spread[0] ?? "");
    }
    this.pageInput.disabled = total === 0;

    const index = this.spreadIndex;
    this.prevBtn.toggleClass("is-disabled", index <= 0);
    this.nextBtn.toggleClass("is-disabled", index >= this.spreads.length - 1);

    // In a right-bound book "next" moves leftwards, so the arrows follow the binding.
    setIcon(this.prevBtn, this.docState.rtl ? "chevron-right" : "chevron-left");
    setIcon(this.nextBtn, this.docState.rtl ? "chevron-left" : "chevron-right");

    this.spreadBtn.toggleClass("is-active", this.docState.spread === "spread");
    setIcon(this.spreadBtn, this.docState.spread === "spread" ? "book-open" : "file");

    this.coverBtn.toggleClass("is-active", this.docState.cover);
    this.coverBtn.toggleClass("is-disabled", this.docState.spread !== "spread");

    this.rtlBtn.toggleClass("is-active", this.docState.rtl);
    setIcon(this.rtlBtn, this.docState.rtl ? "arrow-left" : "arrow-right");
    setTooltip(this.rtlBtn, this.docState.rtl ? "右綴じ（左へ進む）(R)" : "左綴じ（右へ進む）(R)");

    this.fitPageBtn.toggleClass("is-active", this.docState.fit === "page");
    this.fitWidthBtn.toggleClass("is-active", this.docState.fit === "width");
    this.zoomLabel.setText(Math.round(this.renderedScale * 100) + "%");
  }

  private commitPageInput(): void {
    const match = this.pageInput.value.trim().match(/\d+/);
    if (!match || !this.doc) {
      this.updateToolbar();
      return;
    }
    this.goToPage(parseInt(match[0], 10));
  }

  private openZoomMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("全体を表示 / Fit page")
        .setChecked(this.docState.fit === "page")
        .onClick(() => this.setFit("page"))
    );
    menu.addItem((i) =>
      i
        .setTitle("幅に合わせる / Fit width")
        .setChecked(this.docState.fit === "width")
        .onClick(() => this.setFit("width"))
    );
    menu.addSeparator();
    for (const z of [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]) {
      menu.addItem((i) =>
        i
          .setTitle(Math.round(z * 100) + "%")
          .setChecked(this.docState.fit === "custom" && Math.abs(this.docState.zoom - z) < 1e-6)
          .onClick(() => this.setZoom(z))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  // ---------------------------------------------------------------- commands

  goToPage(page: number): void {
    if (!this.doc) return;
    this.docState.page = clamp(Math.round(page), 1, this.doc.numPages);
    // Snap onto the first page of the spread that contains it.
    const spread = this.currentSpread();
    if (spread.length) this.docState.page = spread[0];
    this.updateToolbar();
    void this.render();
  }

  /** `delta` is in reading order: +1 is the next spread, whichever way the book opens. */
  turn(delta: number): void {
    if (!this.spreads.length) return;
    const next = clamp(this.spreadIndex + delta, 0, this.spreads.length - 1);
    if (next === this.spreadIndex) return;
    this.docState.page = this.spreads[next][0];
    this.updateToolbar();
    void this.render();
  }

  goToEdge(which: "first" | "last"): void {
    if (!this.spreads.length) return;
    const index = which === "first" ? 0 : this.spreads.length - 1;
    this.docState.page = this.spreads[index][0];
    this.updateToolbar();
    void this.render();
  }

  toggleSpread(): void {
    this.setSpread(this.docState.spread === "spread" ? "single" : "spread");
  }

  setSpread(mode: SpreadMode): void {
    if (this.docState.spread === mode) return;
    this.docState.spread = mode;
    this.rebuildSpreads();
    this.updateToolbar();
    void this.render();
  }

  toggleCover(): void {
    if (this.docState.spread !== "spread") {
      new Notice("「表紙を表示」は見開き表示のときに使えます。");
      return;
    }
    this.docState.cover = !this.docState.cover;
    this.rebuildSpreads();
    this.updateToolbar();
    void this.render();
    new Notice(this.docState.cover ? "表紙を単独で表示します" : "表紙も見開きに含めます");
  }

  toggleRtl(): void {
    this.docState.rtl = !this.docState.rtl;
    this.updateToolbar();
    void this.render();
    new Notice(this.docState.rtl ? "右綴じ（縦書き向け）" : "左綴じ");
  }

  setFit(fit: FitMode): void {
    this.docState.fit = fit;
    this.lastViewportKey = "";
    this.updateToolbar();
    void this.render();
  }

  setZoom(zoom: number): void {
    this.docState.fit = "custom";
    this.docState.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.updateToolbar();
    void this.render();
  }

  stepZoom(direction: number): void {
    const current = this.renderedScale;
    const next =
      direction > 0
        ? ZOOM_STEPS.filter((z) => z > current * 1.001)[0] ?? MAX_ZOOM
        : ZOOM_STEPS.filter((z) => z < current * 0.999).pop() ?? MIN_ZOOM;
    this.setZoom(next);
  }

  rotate(degrees: number): void {
    this.docState.rotation = (((this.docState.rotation + degrees) % 360) + 360) % 360;
    this.lastViewportKey = "";
    void this.render();
  }

  getDocState(): Readonly<DocState> {
    return this.docState;
  }

  hasDocument(): boolean {
    return this.doc !== null;
  }

  // ------------------------------------------------------------------- input

  private onKeyDown(evt: KeyboardEvent): void {
    if (evt.target === this.pageInput) return;
    if (evt.metaKey || evt.ctrlKey || evt.altKey) return;

    const forward = () => this.turn(1);
    const backward = () => this.turn(-1);
    let handled = true;

    switch (evt.key) {
      case "ArrowRight":
        if (this.docState.rtl) backward();
        else forward();
        break;
      case "ArrowLeft":
        if (this.docState.rtl) forward();
        else backward();
        break;
      case "ArrowDown":
      case "PageDown":
      case " ":
        forward();
        break;
      case "ArrowUp":
      case "PageUp":
        backward();
        break;
      case "Home":
        this.goToEdge("first");
        break;
      case "End":
        this.goToEdge("last");
        break;
      case "+":
      case "=":
        this.stepZoom(1);
        break;
      case "-":
        this.stepZoom(-1);
        break;
      case "0":
        this.setFit("page");
        break;
      case "w":
      case "W":
        this.setFit("width");
        break;
      case "s":
      case "S":
        this.toggleSpread();
        break;
      case "c":
      case "C":
        this.toggleCover();
        break;
      case "r":
      case "R":
        this.toggleRtl();
        break;
      default:
        handled = false;
    }

    if (handled) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  private onWheel(evt: WheelEvent): void {
    if (evt.ctrlKey || evt.metaKey) {
      evt.preventDefault();
      this.stepZoom(evt.deltaY < 0 ? 1 : -1);
      return;
    }
    // When the spread already fits there is nothing to scroll, so the wheel
    // turns pages instead; when it overflows, it only turns at the edges.
    const canScroll = this.stageEl.scrollHeight - this.stageEl.clientHeight > 2;
    if (canScroll) {
      const atTop = this.stageEl.scrollTop <= 0;
      const atBottom =
        this.stageEl.scrollTop >= this.stageEl.scrollHeight - this.stageEl.clientHeight - 1;
      if (!((evt.deltaY < 0 && atTop) || (evt.deltaY > 0 && atBottom))) return;
    }
    if (Math.abs(evt.deltaY) < 4) return;
    const now = Date.now();
    if (now - this.wheelCooldown < 220) {
      evt.preventDefault();
      return;
    }
    this.wheelCooldown = now;
    evt.preventDefault();
    this.turn(evt.deltaY > 0 ? 1 : -1);
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Honours the layout the PDF itself asks for: `/ViewerPreferences /Direction`
   * for the binding side, `/PageLayout` for spread and cover.
   *
   * Only ever turns the spread *on*. `/PageLayout /SinglePage` and `/OneColumn`
   * are what nearly every producer writes by default, so treating them as a
   * deliberate request would quietly cancel the reader's own preference and the
   * plugin would never show a spread at all.
   */
  private async applyDocumentPreferences(doc: PDFDocumentProxy): Promise<void> {
    try {
      const prefs = (await doc.getViewerPreferences()) as Record<string, unknown> | null;
      if (prefs) {
        const direction = findKeyIgnoringCase(prefs, "direction");
        if (typeof direction === "string") {
          this.docState.rtl = direction.toUpperCase() === "R2L";
        }
      }
    } catch {
      /* optional metadata */
    }
    try {
      switch (await doc.getPageLayout()) {
        case "TwoPageRight":
        case "TwoColumnRight":
          this.docState.spread = "spread";
          this.docState.cover = true;
          break;
        case "TwoPageLeft":
        case "TwoColumnLeft":
          this.docState.spread = "spread";
          this.docState.cover = false;
          break;
        default:
          break;
      }
    } catch {
      /* optional metadata */
    }
  }

  private persistState(): void {
    if (!this.file || !this.doc) return;
    this.plugin.saveFileState(this.file.path, this.docState);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function findKeyIgnoringCase(obj: Record<string, unknown>, lowerName: string): unknown {
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lowerName) return obj[key];
  }
  return undefined;
}

function isRenderCancelled(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "RenderingCancelledException"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
