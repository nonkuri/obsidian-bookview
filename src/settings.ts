import { App, PluginSettingTab, Setting } from "obsidian";
import type BookViewPlugin from "./main";
import type { DocState, FitMode, SpreadMode } from "./types";

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
  /** Upper bound on the canvas backing-store scale; higher is sharper but heavier. */
  maxPixelRatio: number;
  fileStates: Record<string, DocState>;
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
  maxPixelRatio: 2,
  fileStates: {},
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
      .setDesc("見開き（2ページ）表示か、単ページ表示か。")
      .addDropdown((d) =>
        d
          .addOption("spread", "見開き / Two-page spread")
          .addOption("single", "単ページ / Single page")
          .setValue(this.plugin.settings.defaultSpread)
          .onChange(async (v) => {
            this.plugin.settings.defaultSpread = v as SpreadMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Right-to-left binding (右綴じ)")
      .setDesc("縦書きの日本語書籍のように、1ページ目を右側に置きます。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.defaultRtl).onChange(async (v) => {
          this.plugin.settings.defaultRtl = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show cover page (表紙を表示)")
      .setDesc(
        "Acrobat Reader と同じ挙動です。1ページ目（表紙）だけを単独で表示し、2ページ目以降を 2-3、4-5 … と見開きにします。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.defaultCover).onChange(async (v) => {
          this.plugin.settings.defaultCover = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Zoom mode")
      .setDesc("開いたときの拡大率の決め方。")
      .addDropdown((d) =>
        d
          .addOption("page", "全体を表示 / Fit page")
          .addOption("width", "幅に合わせる / Fit width")
          .setValue(this.plugin.settings.defaultFit === "width" ? "width" : "page")
          .onChange(async (v) => {
            this.plugin.settings.defaultFit = v as FitMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Detect layout from the PDF")
      .setDesc(
        "PDF 自身が綴じ方向（/ViewerPreferences /Direction）や見開き（/PageLayout の TwoPage…／TwoColumn…）を指定していれば、それを上記の既定値より優先します。" +
          "単ページ指定（SinglePage・OneColumn）はほぼすべての PDF が既定で書き込むだけの値なので無視します。"
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
        "表紙や最終ページのように片側しかないときに、中央ではなく綴じ側に寄せて配置します（Acrobat と同じ見え方）。"
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
      .setDesc("見開きの左右ページの間隔（ピクセル）。")
      .addSlider((s) =>
        s
          .setLimits(0, 48, 1)
          .setValue(this.plugin.settings.spreadGap)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.spreadGap = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Page shadow")
      .setDesc("ページの縁に影を付けます。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pageShadow).onChange(async (v) => {
          this.plugin.settings.pageShadow = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Invert colours in dark mode")
      .setDesc("ダークテーマのときに PDF の色を反転して表示します（白地の文書向け）。")
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
        "描画に使う解像度の上限（画面の devicePixelRatio に対する倍率）。大きいほど綺麗ですが重くなります。"
      )
      .addSlider((s) =>
        s
          .setLimits(1, 4, 0.5)
          .setValue(this.plugin.settings.maxPixelRatio)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxPixelRatio = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl).setName("Behaviour").setHeading();

    new Setting(containerEl)
      .setName("Use BookView for .pdf files")
      .setDesc(
        "Vault 内の PDF を、Obsidian 標準のビューアではなく BookView で開きます。オフにすると、コマンド「Open in BookView」やファイルメニューから個別に開けます。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.overridePdfViewer).onChange(async (v) => {
          this.plugin.settings.overridePdfViewer = v;
          await this.plugin.saveSettings();
          this.plugin.applyPdfExtensionOverride();
        })
      );

    new Setting(containerEl)
      .setName("Remember settings per file")
      .setDesc("ファイルごとに綴じ方向・見開き・表示ページを記憶し、次回開いたときに復元します。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.rememberPerFile).onChange(async (v) => {
          this.plugin.settings.rememberPerFile = v;
          await this.plugin.saveSettings();
        })
      );

    const remembered = Object.keys(this.plugin.settings.fileStates).length;
    new Setting(containerEl)
      .setName("Clear remembered files")
      .setDesc(`記憶済み: ${remembered} ファイル`)
      .addButton((b) =>
        b
          .setButtonText("消去 / Clear")
          .setWarning()
          .setDisabled(remembered === 0)
          .onClick(async () => {
            this.plugin.settings.fileStates = {};
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }
}
