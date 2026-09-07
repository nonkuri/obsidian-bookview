/**
 * Types for the vendored `view.js`. Written by BookView, not copied from
 * upstream — foliate-js ships no typings — and deliberately narrow: it declares
 * only the surface `src/epub/` uses, so that an upstream change we depend on
 * shows up as a compile error rather than at runtime.
 */

/** One entry of the book's navigation document. */
export interface TOCItem {
  label: string;
  href: string;
  subitems?: TOCItem[] | null;
}

export interface BookMetadata {
  /** Either a plain string or a language map, e.g. `{ ja: "草枕", en: "Kusamakura" }`. */
  title?: string | Record<string, string>;
  language?: string | string[];
  author?: unknown;
}

export interface BookRendition {
  layout?: string;
  spread?: string;
  orientation?: string;
}

/**
 * The subset of foliate's "book" interface BookView touches. `EPUB` implements
 * it; so would any other reader we later plug in.
 */
export interface Book {
  sections: { linear?: string }[];
  /** Page progression direction, straight from the OPF spine. */
  dir?: "rtl" | "ltr";
  toc?: TOCItem[] | null;
  metadata?: BookMetadata;
  rendition?: BookRendition;
  /**
   * Fires `data` for every resource on its way to a blob URL, with a mutable
   * `detail.data`. This is the only hook that can put a CSP in front of the
   * book's own markup — see `src/epub/csp.ts`.
   */
  transformTarget?: EventTarget;
  destroy?(): void;
}

/** `detail` of the `data` event on {@link Book.transformTarget}. */
export interface TransformDetail {
  data: string | Blob | Promise<string | Blob>;
  type: string;
  readonly name: string;
}

/** `detail` of the renderer's `load` event. */
export interface LoadDetail {
  doc: Document;
  index: number;
}

/** `detail` of `relocate`, measured against the vendored build. */
export interface RelocateDetail {
  fraction: number;
  /** Position within the spine. Note: `section`, not `index`, whatever the upstream README says. */
  section: { current: number; total: number };
  /** Synthetic page numbers. `next` is the first page of the following screen. */
  location: { current: number; next: number; total: number };
  time: { section: number; total: number };
  /** The deepest TOC entry covering this position, or null outside any. */
  tocItem: TOCItem | null;
  pageItem: TOCItem | null;
  cfi: string;
  range?: Range;
}

export interface Renderer extends HTMLElement {
  /** Applies a stylesheet on top of the book's own, in every section. */
  setStyles?(css: string): void;
  getContents(): { doc: Document; index: number }[];
  destroy?(): void;
}

export declare class View extends HTMLElement {
  book: Book;
  /** `foliate-paginator` for reflowable books, `foliate-fxl` for pre-paginated ones. */
  renderer: Renderer;
  isFixedLayout: boolean;
  lastLocation?: RelocateDetail;
  open(book: Book | Blob | string): Promise<void>;
  close(): void;
  /** Accepts a CFI string, an href, or a spine index. */
  goTo(target: string | number): Promise<void>;
  goToFraction(fraction: number): Promise<void>;
  goToTextStart(): Promise<void>;
  next(distance?: number): Promise<void>;
  prev(distance?: number): Promise<void>;
  /** Both honour `book.dir`, so in a right-bound book `goLeft` advances. */
  goLeft(): Promise<void>;
  goRight(): Promise<void>;
}
