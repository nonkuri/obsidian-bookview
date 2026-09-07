import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSource from "pdfjs-worker-source";
import cmapTable from "pdfjs-cmaps";

export type PDFDocumentProxy = pdfjs.PDFDocumentProxy;
export type PDFPageProxy = pdfjs.PDFPageProxy;
export type PageViewport = pdfjs.PageViewport;
export type RenderTask = pdfjs.RenderTask;

let workerUrl: string | null = null;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reads the CMaps that were inlined into the bundle instead of fetching them
 * over the network. CJK PDFs that use a predefined encoding (UniJIS-UCS2-H,
 * 90ms-RKSJ-H, ...) — which is most Japanese PDFs — cannot be rendered without
 * these tables.
 */
class InlineCMapReaderFactory {
  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    const base64 = cmapTable[name];
    if (!base64) throw new Error(`Unable to load CMap: ${name}`);
    // The bundled tables are the packed `.bcmap` files pdf.js ships with.
    return { cMapData: base64ToBytes(base64), isCompressed: true };
  }
}

/** Must be called once before {@link loadPdfDocument}. */
export function initPdfJs(): void {
  if (workerUrl) return;
  // pdf.js starts this as a module worker, which a blob URL serves happily.
  const blob = new Blob([workerSource], { type: "application/javascript" });
  workerUrl = URL.createObjectURL(blob);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}

export function disposePdfJs(): void {
  if (!workerUrl) return;
  URL.revokeObjectURL(workerUrl);
  workerUrl = null;
}

export function loadPdfDocument(data: ArrayBuffer): pdfjs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    // pdf.js transfers (and neuters) the buffer, so hand it a private copy.
    data: new Uint8Array(data.slice(0)),
    cMapUrl: "inline:",
    cMapPacked: true,
    CMapReaderFactory: InlineCMapReaderFactory,
    useWorkerFetch: false,
    isEvalSupported: false,
    enableXfa: true,
  });
}

export const pdfjsVersion: string = pdfjs.version;
