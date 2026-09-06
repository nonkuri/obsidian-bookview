declare module "pdfjs-worker-source" {
  const source: string;
  export default source;
}

declare module "pdfjs-cmaps" {
  /** cMap name (without the `.bcmap` extension) -> base64 encoded binary CMap. */
  const cmaps: Record<string, string>;
  export default cmaps;
}
