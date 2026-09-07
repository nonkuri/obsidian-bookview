/** Types for the vendored `epub.js`. Written by BookView; see `view.d.ts`. */
import type { Book } from "./view";

/**
 * What `epub.js` needs in order to read an archive. A miss resolves to `null`
 * rather than throwing, which is how the parser probes for optional files.
 */
export interface Loader {
  loadText(name: string): Promise<string | null> | string | null;
  loadBlob(name: string, type?: string): Promise<Blob | null> | Blob | null;
  getSize(name: string): number;
}

export declare class EPUB implements Book {
  constructor(loader: Loader);
  init(): Promise<this>;
  sections: { linear?: string }[];
  dir?: "rtl" | "ltr";
  toc?: import("./view").TOCItem[] | null;
  metadata?: import("./view").BookMetadata;
  rendition?: import("./view").BookRendition;
  transformTarget?: EventTarget;
  destroy(): void;
}
