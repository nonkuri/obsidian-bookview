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
