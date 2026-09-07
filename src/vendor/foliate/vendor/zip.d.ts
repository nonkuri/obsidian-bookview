/** Types for the vendored zip.js, narrowed to what `src/epub/loader.ts` uses. */

export declare function configure(options: { useWebWorkers?: boolean }): void;

export declare class BlobReader {
  constructor(blob: Blob);
}

// The two writers are structurally identical, which would let TypeScript pick
// either overload of `getData()`. The brands keep them apart.
export declare class TextWriter {
  constructor(encoding?: string);
  private readonly __text: unique symbol;
}

export declare class BlobWriter {
  constructor(type?: string);
  private readonly __blob: unique symbol;
}

export interface ZipEntry {
  filename: string;
  uncompressedSize: number;
  directory: boolean;
  getData(writer: TextWriter): Promise<string>;
  getData(writer: BlobWriter): Promise<Blob>;
}

export declare class ZipReader {
  constructor(reader: BlobReader);
  getEntries(): Promise<ZipEntry[]>;
  close(): Promise<void>;
}
