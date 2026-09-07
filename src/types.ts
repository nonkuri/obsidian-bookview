/** One page at a time, or a two-page spread. */
export type SpreadMode = "single" | "spread";

/** How the current spread is scaled into the viewport. */
export type FitMode = "page" | "width" | "custom";

/** Everything that describes how one document is currently being displayed. */
export interface DocState {
  spread: SpreadMode;
  /**
   * Acrobat's "Show Cover Page in Two Page View": page 1 is shown on its own,
   * and pairing starts at page 2 (2-3, 4-5, ...).
   */
  cover: boolean;
  /** Right-to-left binding: pages are paired right to left, as in a Japanese book. */
  rtl: boolean;
  fit: FitMode;
  /** Only meaningful when `fit === "custom"`. */
  zoom: number;
  /** The page the reader is currently on; the shown spread is the one containing it. */
  page: number;
  /** Extra rotation in degrees, on top of the page's own /Rotate. */
  rotation: number;
}

/** Paginated like a book, or scrolled like a web page. */
export type FlowMode = "paginated" | "scrolled";

/**
 * How one EPUB is currently being displayed. Kept apart from {@link DocState}
 * rather than folded into it: a reflowable book has no fixed pages to number, so
 * a position is a CFI, and there is no zoom or rotation to remember — the reader
 * changes the type size instead.
 */
export interface EpubState {
  /** EPUB CFI of the reading position, or `null` before the book has been read. */
  cfi: string | null;
  flow: FlowMode;
  /**
   * Columns per screen in horizontal writing. Vertical writing ignores it: the
   * text already runs right to left across the full width, which is the spread.
   */
  columns: number;
  /** Type size as a percentage of the reader's default. */
  fontScale: number;
}
