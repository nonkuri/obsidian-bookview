/**
 * A stand-in for the `obsidian` module, just complete enough to run the real
 * BookPdfView in a plain browser page. Development-only; never bundled into
 * the plugin.
 */

/* -------------------------------------------------- DOM helpers (Obsidian) */

type ElInfo = { cls?: string; text?: string; type?: string };

function applyInfo(el: HTMLElement, info?: ElInfo) {
  if (!info) return el;
  if (info.cls) el.className = info.cls;
  if (info.text !== undefined) el.textContent = info.text;
  if (info.type) el.setAttribute("type", info.type);
  return el;
}

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;

proto.createEl = function (tag: string, info?: ElInfo) {
  const el = document.createElement(tag);
  applyInfo(el, info);
  (this as HTMLElement).appendChild(el);
  return el;
};
proto.createDiv = function (info?: ElInfo | string) {
  return (this as HTMLElement & { createEl: (t: string, i?: ElInfo) => HTMLElement }).createEl(
    "div",
    typeof info === "string" ? { cls: info } : info
  );
};
proto.createSpan = function (info?: ElInfo | string) {
  return (this as HTMLElement & { createEl: (t: string, i?: ElInfo) => HTMLElement }).createEl(
    "span",
    typeof info === "string" ? { cls: info } : info
  );
};
proto.empty = function () {
  const el = this as HTMLElement;
  while (el.firstChild) el.removeChild(el.firstChild);
};
proto.addClass = function (...cls: string[]) {
  (this as HTMLElement).classList.add(...cls);
};
proto.removeClass = function (...cls: string[]) {
  (this as HTMLElement).classList.remove(...cls);
};
proto.toggleClass = function (cls: string, on: boolean) {
  (this as HTMLElement).classList.toggle(cls, on);
};
proto.setText = function (text: string) {
  (this as HTMLElement).textContent = text;
};
proto.setAttr = function (name: string, value: string) {
  (this as HTMLElement).setAttribute(name, value);
};
proto.show = function () {
  (this as HTMLElement).style.display = "";
};
proto.hide = function () {
  (this as HTMLElement).style.display = "none";
};

/* ------------------------------------------------------------------ API -- */

const ICON_TEXT: Record<string, string> = {
  "chevron-left": "‹",
  "chevron-right": "›",
  "book-open": "\u{1F4D6}",
  book: "\u{1F4D5}",
  file: "\u{1F4C4}",
  "arrow-left": "←",
  "arrow-right": "→",
  "zoom-in": "+",
  "zoom-out": "−",
  maximize: "⛶",
  "move-horizontal": "↔",
  "rotate-cw": "↻",
};

export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute("data-icon", icon);
  el.textContent = ICON_TEXT[icon] ?? icon;
}

export function setTooltip(el: HTMLElement, text: string): void {
  el.title = text;
}

export class Notice {
  constructor(message: string) {
    console.log("[Notice]", message);
    const el = document.body.appendChild(document.createElement("div"));
    el.className = "stub-notice";
    el.textContent = message;
    setTimeout(() => el.remove(), 2000);
  }
}

export class Menu {
  addItem(cb: (item: MenuItem) => void): this {
    cb(new MenuItem());
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_evt: MouseEvent): this {
    return this;
  }
}

class MenuItem {
  setTitle(): this {
    return this;
  }
  setIcon(): this {
    return this;
  }
  setChecked(): this {
    return this;
  }
  onClick(): this {
    return this;
  }
}

export class TFile {
  constructor(public path: string, public basename: string, public extension: string) {}
}

export class WorkspaceLeaf {}

export type ViewStateResult = Record<string, unknown>;

export class View {
  containerEl: HTMLElement;
  app: { vault: { readBinary(file: TFile): Promise<ArrayBuffer> } };
  private cleanups: Array<() => void> = [];

  constructor(public leaf: WorkspaceLeaf) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
    this.containerEl.appendChild(document.createElement("div")); // header placeholder
    const content = document.createElement("div");
    content.className = "view-content";
    this.containerEl.appendChild(content);
    this.app = { vault: { readBinary: async () => new ArrayBuffer(0) } };
  }

  registerDomEvent(
    el: HTMLElement,
    type: string,
    cb: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions
  ): void {
    el.addEventListener(type, cb, options);
    this.cleanups.push(() => el.removeEventListener(type, cb, options));
  }

  register(cb: () => void): void {
    this.cleanups.push(cb);
  }

  unload(): void {
    for (const cb of this.cleanups) cb();
    this.cleanups = [];
  }

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: ViewStateResult): Promise<void> {}

  onPaneMenu(_menu: Menu, _source: string): void {}

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class FileView extends View {
  file: TFile | null = null;

  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}

  /** Test-only entry point standing in for Obsidian's leaf.openFile(). */
  async loadFileForTest(file: TFile): Promise<void> {
    this.file = file;
    await this.onLoadFile(file);
  }
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number) {
  let timer: number | null = null;
  const wrapped = ((...args: Parameters<T>) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  }) as T & { cancel(): void };
  wrapped.cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
  };
  return wrapped;
}

/* Only present so `src/settings.ts` can be imported for its DEFAULT_SETTINGS. */
export class App {}
export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(_app: unknown, _plugin: unknown) {}
  display(): void {}
}
export class Setting {
  constructor(_containerEl: HTMLElement) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  setHeading(): this { return this; }
  addToggle(): this { return this; }
  addDropdown(): this { return this; }
  addSlider(): this { return this; }
  addButton(): this { return this; }
}
