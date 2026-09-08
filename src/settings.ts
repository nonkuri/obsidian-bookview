import { App, PluginSettingTab, Setting } from "obsidian";
import type BookViewPlugin from "./main";
import type { DocState, EpubState, FitMode, FlowMode, SpreadMode } from "./types";

/** Upper end of both EPUB margin sliders, on the toolbar and in the settings tab. */
export const EPUB_MARGIN_MAX = 400;

/** Step both margin sliders move in, in pixels. */
export const EPUB_MARGIN_STEP = 4;

export interface BookViewSettings {
  defaultSpread: SpreadMode;
  defaultCover: boolean;
  defaultRtl: boolean;
  defaultFit: FitMode;
  /** Honour the PDF's own /ViewerPreferences and /PageLayout when opening it. */
  autoDetect: boolean;
  /** Keep a lone cover / final page on its binding side instead of centring it. */
  alignSinglePages: boolean;
  /** Gap between the two halves of a spread, in CSS pixels. */
  spreadGap: number;
  pageShadow: boolean;
  invertInDarkMode: boolean;
  rememberPerFile: boolean;
  /** Make BookView the handler for `.pdf` files instead of the built-in viewer. */
  overridePdfViewer: boolean;
  /**
   * Make BookView the handler for `.epub` files. Obsidian has no EPUB viewer of
   * its own, but another plugin may already have claimed the extension.
   */
  overrideEpubViewer: boolean;
  /** Upper bound on the canvas backing-store scale; higher is sharper but heavier. */
  maxPixelRatio: number;
  fileStates: Record<string, DocState>;

  // --- EPUB. Kept apart from the PDF settings above because almost nothing
  // carries over: a reflowable book has no pages to fit or rotate.
  defaultFlow: FlowMode;
  /** Columns per screen in horizontal writing. Vertical writing always fills the width. */
  defaultColumns: number;
  defaultFontScale: number;
  /** Space between columns, as a percentage of the page. */
  epubGap: number;
  /**
   * Cap on the measure of a horizontally set book, in pixels, so a wide pane
   * does not produce unreadable lines. A vertically set book measures its lines
   * down the page instead, and is capped by {@link epubMaxVerticalHeight}.
   */
  epubMaxLineLength: number;
  /**
   * The same cap for a vertically set book, where the measure is the height of
   * the text. Kept apart from {@link epubMaxLineLength} because the two are the
   * same number read against different edges of the screen: a pane is far
   * shorter than it is wide, so a measure that leaves a horizontal book
   * readable leaves a vertical one floating in white.
   */
  epubMaxVerticalHeight: number;
  /**
   * Cap on the text area in the direction the lines stack, in pixels: the width
   * of a vertically set book, the height of a horizontal one. Starts wider than
   * any pane, so that the margins below are what decides the white space; a
   * limit narrower than the pane takes over from them, because the renderer
   * centres what it has capped and the leftover swallows the margin whole.
   */
  epubMaxBlockSize: number;
  epubLineHeight: number;
  /**
   * Space kept clear at the top and bottom edges of the pane, in pixels. Both
   * this and {@link epubHorizontalMargin} are physical edges of the pane, not
   * the book's own margins, so they mean the same thing however the book is set.
   * A margin is a floor: whatever the limits above leave over is added to it.
   */
  epubVerticalMargin: number;
  /** Space kept clear at the left and right edges of the pane, in pixels. */
  epubHorizontalMargin: number;
  epubStates: Record<string, EpubState>;
}

export const DEFAULT_SETTINGS: BookViewSettings = {
  defaultSpread: "spread",
  defaultCover: true,
  defaultRtl: true,
  defaultFit: "page",
  autoDetect: true,
  alignSinglePages: true,
  spreadGap: 8,
  pageShadow: true,
  invertInDarkMode: false,
  rememberPerFile: true,
  overridePdfViewer: true,
  overrideEpubViewer: true,
  maxPixelRatio: 2,
  fileStates: {},

  defaultFlow: "paginated",
  defaultColumns: 2,
  defaultFontScale: 100,
  epubGap: 6,
  epubMaxLineLength: 720,
  epubMaxVerticalHeight: 2400,
  epubMaxBlockSize: 4000,
  epubLineHeight: 1.7,
  epubVerticalMargin: 24,
  epubHorizontalMargin: 0,
  epubStates: {},
};

export class BookViewSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BookViewPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Defaults for newly opened PDFs").setHeading();

    new Setting(containerEl)
      .setName("Page layout")
      .setDesc("Show two pages side by side, or a single page at a time.")
      .addDropdown((d) =>
        d
          .addOption("spread", "Two-page spread")
          .addOption("single", "Single page")
          .setValue(this.plugin.settings.defaultSpread)
          .onChange(async (v) => {
            this.plugin.settings.defaultSpread = v as SpreadMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Right-to-left binding")
      .setDesc("Pair pages from right to left, the way vertically written Japanese books are bound.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.defaultRtl).onChange(async (v) => {
          this.plugin.settings.defaultRtl = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show cover page")
      .setDesc(
        "Show page 1 on its own and pair the rest as 2-3, 4-5, and so on, like the cover page option in Acrobat Reader."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.defaultCover).onChange(async (v) => {
          this.plugin.settings.defaultCover = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Zoom mode")
      .setDesc("How the zoom level is chosen when a document is opened.")
      .addDropdown((d) =>
        d
          .addOption("page", "Fit page")
          .addOption("width", "Fit width")
          .setValue(this.plugin.settings.defaultFit === "width" ? "width" : "page")
          .onChange(async (v) => {
            this.plugin.settings.defaultFit = v as FitMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Detect layout from the PDF")
      .setDesc(
        "Let a PDF that states its own binding direction (/ViewerPreferences /Direction) or spread " +
          "(/PageLayout TwoPage… or TwoColumn…) override the defaults above. Single-page hints " +
          "(SinglePage, OneColumn) are ignored, because nearly every PDF writes one by default. " +
          "Hardly any PDF states a direction, so the binding is otherwise guessed from the text: " +
          "vertically set Japanese, Hebrew and Arabic open right-bound, and a document with none of " +
          "those opens left-bound. Horizontal Japanese and scans keep the default above."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoDetect).onChange(async (v) => {
          this.plugin.settings.autoDetect = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Appearance").setHeading();

    new Setting(containerEl)
      .setName("Align lone pages to the binding edge")
      .setDesc(
        "When a spread holds only one page, such as the cover or a final page, keep it on the binding " +
          "side instead of centring it, the way Acrobat Reader does."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.alignSinglePages).onChange(async (v) => {
          this.plugin.settings.alignSinglePages = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Spread gap")
      .setDesc("Space between the left and right halves of a spread, in pixels.")
      .addSlider((s) =>
        s
          .setLimits(0, 48, 1)
          .setValue(this.plugin.settings.spreadGap)
          .onChange(async (v) => {
            this.plugin.settings.spreadGap = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Page shadow")
      .setDesc("Draw a drop shadow around the edge of each page.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pageShadow).onChange(async (v) => {
          this.plugin.settings.pageShadow = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Invert colors in dark mode")
      .setDesc(
        "Invert the colors of the rendered page, or of an EPUB's own styling, under a dark theme. " +
          "Suits documents on white."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.invertInDarkMode).onChange(async (v) => {
          this.plugin.settings.invertInDarkMode = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Render quality")
      .setDesc(
        "Upper bound on the rendering resolution, as a multiple of the screen pixel ratio. " +
          "Higher is sharper but slower."
      )
      .addSlider((s) =>
        s
          .setLimits(1, 4, 0.5)
          .setValue(this.plugin.settings.maxPixelRatio)
          .onChange(async (v) => {
            this.plugin.settings.maxPixelRatio = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl).setName("Defaults for newly opened EPUBs").setHeading();

    new Setting(containerEl)
      .setName("Reading mode")
      .setDesc("Turn pages like a book, or scroll continuously like a web page.")
      .addDropdown((d) =>
        d
          .addOption("paginated", "Paginated")
          .addOption("scrolled", "Scrolled")
          .setValue(this.plugin.settings.defaultFlow)
          .onChange(async (v) => {
            this.plugin.settings.defaultFlow = v as FlowMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Two columns")
      .setDesc(
        "Show two columns side by side in horizontally written books, the way a printed page " +
          "falls open. Vertically written Japanese is unaffected: its text already runs right to " +
          "left across the whole width, which is the spread."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.defaultColumns > 1).onChange(async (v) => {
          this.plugin.settings.defaultColumns = v ? 2 : 1;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Type size")
      .setDesc("Starting size for the book's text, as a percentage of its own.")
      .addSlider((s) =>
        s
          .setLimits(70, 200, 10)
          .setValue(this.plugin.settings.defaultFontScale)
          .onChange(async (v) => {
            this.plugin.settings.defaultFontScale = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Line length")
      .setDesc(
        "Upper bound on the measure, in pixels. Without one, a wide pane produces lines too long " +
          "to read comfortably. Horizontal writing only — a vertically set book measures its " +
          "lines down the page, and has a setting of its own below."
      )
      .addSlider((s) =>
        s
          .setLimits(400, 1600, 20)
          .setValue(this.plugin.settings.epubMaxLineLength)
          .onChange(async (v) => {
            this.plugin.settings.epubMaxLineLength = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Body height in vertical writing")
      .setDesc(
        "The same upper bound for a vertically set book, where a line runs down the page rather " +
          "than across it, so this is how tall the text block is allowed to be. At the top of the " +
          "range it stops constraining anything on any screen, which is where it starts: a page of " +
          "a Japanese book runs to the foot of the page."
      )
      .addSlider((s) =>
        s
          .setLimits(400, 3200, 20)
          .setValue(this.plugin.settings.epubMaxVerticalHeight)
          .onChange(async (v) => {
            this.plugin.settings.epubMaxVerticalHeight = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Body width in vertical writing")
      .setDesc(
        "How far the text runs across the page in a vertically set book. A horizontally set one " +
          "is unaffected in width — there the same limit caps the height instead, because it bounds " +
          "the direction the lines stack. It starts at the top of the range, wider than any pane, " +
          "so that the margins below are what decides the white space. Bring it down and it takes " +
          "over from them: the renderer centres the text it has narrowed, and that leftover is " +
          "wider than the margin."
      )
      .addSlider((s) =>
        s
          .setLimits(800, 4000, 40)
          .setValue(this.plugin.settings.epubMaxBlockSize)
          .onChange(async (v) => {
            this.plugin.settings.epubMaxBlockSize = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Line spacing")
      .setDesc("Leading for body text, as a multiple of the type size.")
      .addSlider((s) =>
        s
          .setLimits(1.2, 2.4, 0.1)
          .setValue(this.plugin.settings.epubLineHeight)
          .onChange(async (v) => {
            this.plugin.settings.epubLineHeight = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Column gap")
      .setDesc("Space between columns, as a percentage of the page.")
      .addSlider((s) =>
        s
          .setLimits(0, 20, 1)
          .setValue(this.plugin.settings.epubGap)
          .onChange(async (v) => {
            this.plugin.settings.epubGap = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Top and bottom margin")
      .setDesc(
        "Space kept clear above and below the text, in pixels. Also on the toolbar, under the " +
          "margins button. This is a floor: whatever the limits above leave over is added to it."
      )
      .addSlider((s) =>
        s
          .setLimits(0, EPUB_MARGIN_MAX, EPUB_MARGIN_STEP)
          .setValue(this.plugin.settings.epubVerticalMargin)
          .onChange(async (v) => {
            this.plugin.settings.epubVerticalMargin = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Left and right margin")
      .setDesc(
        "Space kept clear at the sides of the text, in pixels, on top of what the column gap " +
          "already leaves. Also on the toolbar, under the margins button."
      )
      .addSlider((s) =>
        s
          .setLimits(0, EPUB_MARGIN_MAX, EPUB_MARGIN_STEP)
          .setValue(this.plugin.settings.epubHorizontalMargin)
          .onChange(async (v) => {
            this.plugin.settings.epubHorizontalMargin = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl).setName("Behavior").setHeading();

    new Setting(containerEl)
      .setName("Open PDF files in BookView")
      .setDesc(
        "Use BookView instead of the built-in viewer for PDFs in this vault. When off, open a PDF in " +
          "BookView one at a time from the file menu or from the command palette."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.overridePdfViewer).onChange(async (v) => {
          this.plugin.settings.overridePdfViewer = v;
          await this.plugin.saveSettings();
          this.plugin.applyExtensionOverrides();
        })
      );

    new Setting(containerEl)
      .setName("Open EPUB files in BookView")
      .setDesc(
        "Obsidian cannot open EPUBs on its own, so this is normally what you want. Turn it off to " +
          "leave the extension to another plugin that handles it; whichever plugin held it before " +
          "gets it back when BookView is disabled."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.overrideEpubViewer).onChange(async (v) => {
          this.plugin.settings.overrideEpubViewer = v;
          await this.plugin.saveSettings();
          this.plugin.applyExtensionOverrides();
        })
      );

    new Setting(containerEl)
      .setName("Remember settings per file")
      .setDesc(
        "Store the binding direction, spread mode, and current page of each PDF, and the reading " +
          "position and type size of each EPUB, and restore them the next time the file is opened."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.rememberPerFile).onChange(async (v) => {
          this.plugin.settings.rememberPerFile = v;
          await this.plugin.saveSettings();
        })
      );

    const remembered =
      Object.keys(this.plugin.settings.fileStates).length +
      Object.keys(this.plugin.settings.epubStates).length;
    new Setting(containerEl)
      .setName("Clear remembered files")
      .setDesc(`Currently remembering ${remembered} file${remembered === 1 ? "" : "s"}.`)
      .addButton((b) =>
        b
          .setButtonText("Clear")
          .setWarning()
          .setDisabled(remembered === 0)
          .onClick(async () => {
            this.plugin.settings.fileStates = {};
            this.plugin.settings.epubStates = {};
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }
}
