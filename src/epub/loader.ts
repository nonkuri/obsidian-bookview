import { EPUB, type Loader } from "../vendor/foliate/epub";
import {
  BlobReader,
  BlobWriter,
  TextWriter,
  ZipReader,
  configure,
  type ZipEntry,
} from "../vendor/foliate/vendor/zip";
import type { Book } from "../vendor/foliate/view";
import { guardBook } from "./csp";

let configured = false;

/**
 * Reads an EPUB out of the bytes `Vault.readBinary()` gave us.
 *
 * foliate's own loader takes a `File` and would do this too, but it is not
 * exported, and going through it would mean letting it sniff the format and
 * possibly pick a reader BookView does not ship. Building the EPUB here keeps
 * the path explicit, and — the reason that matters — leaves room to install the
 * Content-Security-Policy before the first section is rendered.
 */
export async function openEpub(data: ArrayBuffer): Promise<Book> {
  const book = await new EPUB(makeZipLoader(data)).init();
  guardBook(book);
  return book;
}

function makeZipLoader(data: ArrayBuffer): Loader & { close(): Promise<void> } {
  if (!configured) {
    // Workers would need a second blob URL and buy nothing: a book is a handful
    // of small files, read once each.
    configure({ useWebWorkers: false });
    configured = true;
  }

  const reader = new ZipReader(new BlobReader(new Blob([data])));
  let entries: Map<string, ZipEntry> | null = null;

  const find = async (name: string): Promise<ZipEntry | null> => {
    if (!entries) {
      entries = new Map((await reader.getEntries()).map((e) => [e.filename, e]));
    }
    return entries.get(name) ?? null;
  };

  return {
    async loadText(name) {
      const entry = await find(name);
      return entry ? entry.getData(new TextWriter()) : null;
    },
    async loadBlob(name, type) {
      const entry = await find(name);
      return entry ? entry.getData(new BlobWriter(type)) : null;
    },
    getSize(name) {
      // Only used to weight reading-progress estimates, and only after the
      // entries have been read, so a synchronous miss is harmless.
      return entries?.get(name)?.uncompressedSize ?? 0;
    },
    close: () => reader.close(),
  };
}

