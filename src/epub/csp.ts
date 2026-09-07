import type { Book, TransformDetail } from "../vendor/foliate/view";

/**
 * An EPUB is a zip of arbitrary HTML, and EPUB 3 allows it to carry scripts.
 * foliate-js renders each section in an iframe whose `sandbox` reads
 * `allow-same-origin allow-scripts` — it has to, because the events it needs do
 * not fire otherwise (WebKit bug 218086) — so the sandbox attribute stops
 * nothing. A Content-Security-Policy is the only thing standing between a book
 * and the vault it is being read in.
 *
 * A plugin cannot set response headers, so the policy travels in the markup: the
 * loader fires `data` for every resource on its way to a blob URL, and the
 * `<meta>` goes in before the document is ever parsed.
 *
 * Scripts and network access are both denied outright. Nothing an EPUB legally
 * needs is lost — a book is markup, styles and media — and it is what keeps the
 * promise that BookView never touches the network.
 */
const POLICY = [
  "default-src 'none'",
  // The book's own resources, which the loader has already turned into blobs.
  "img-src blob: data:",
  "media-src blob: data:",
  "font-src blob: data:",
  // Stylesheets arrive inlined (see below), which is what 'unsafe-inline' is for.
  "style-src blob: data: 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY}"/>`;

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** The media types whose markup the policy has to be planted in. */
const MARKUP_TYPES = new Set([
  "application/xhtml+xml",
  "application/xml",
  "text/html",
  "text/xml",
  "image/svg+xml",
]);

let warnedAboutStylesheets = false;

/**
 * Puts {@link POLICY} in front of every document in `book`, and inlines the
 * book's stylesheets on the way. Must be called before the book is handed to a
 * renderer, because sections are transformed as they load and the first one
 * loads immediately.
 */
export function guardBook(book: Book): void {
  const target = book.transformTarget;
  if (!target) {
    // Not reachable with the EPUB reader, but a renderer swapped in later could
    // lack the hook, and failing open would be the one outcome worth avoiding.
    throw new Error("BookView: this book cannot be secured, refusing to render it");
  }

  target.addEventListener("data", (event) => {
    const detail = (event as CustomEvent<TransformDetail>).detail;
    if (!MARKUP_TYPES.has(detail.type)) return;
    const type = detail.type;
    detail.data = Promise.resolve(detail.data).then(
      (data): string | Blob | Promise<string> =>
        typeof data === "string" ? harden(data, type) : data
    );
  });
}

async function harden(markup: string, type: string): Promise<string> {
  const parseAs = type === "application/xml" || type === "text/xml" ? "text/xml" : type;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(markup, parseAs as DOMParserSupportedType);
    if (doc.querySelector("parsererror") || !doc.documentElement) throw new Error("unparseable");
  } catch {
    // Never hand back a document without a policy; fall back to splicing the
    // meta in as text, which is what this did before it also inlined styles.
    return insertMetaAsText(markup);
  }

  await inlineStylesheets(doc);
  insertMeta(doc);
  return serialize(doc, type);
}

/**
 * XMLSerializer escapes `<`, `>` and `&` in every text node, including the ones
 * inside `<style>`. Re-parsed as XML that is undone again, but in an HTML
 * document `<style>` holds raw text, so a child selector would arrive as
 * `div &gt; p` and stop matching. HTML documents get the HTML serializer.
 */
function serialize(doc: Document, type: string): string {
  if (type !== "text/html") return new XMLSerializer().serializeToString(doc);
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "";
  return doctype + doc.documentElement.outerHTML;
}

/**
 * Replaces `<link rel="stylesheet">` with the stylesheet's own text.
 *
 * The loader hands every resource to the document as a `blob:` URL, and a
 * `blob:` document inherits the Content-Security-Policy of whatever created it
 * — here, Obsidian's own app page, whose `style-src` does not list `blob:`. The
 * link is refused however permissive this plugin's policy is, and the book then
 * renders with none of its own typography, which for a vertically set Japanese
 * book means it does not render as a book at all.
 *
 * `'unsafe-inline'` *is* allowed, so the text goes in as a `<style>` instead.
 */
async function inlineStylesheets(doc: Document): Promise<void> {
  const links = Array.from(doc.querySelectorAll("link[href]")).filter(isStylesheet);
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href || !href.startsWith("blob:")) continue;

    let css: string;
    try {
      // Read from this window, not the book's: `connect-src 'none'` in the
      // policy above is exactly what should stop the book doing this itself.
      css = await (await fetch(href)).text();
    } catch (err) {
      if (!warnedAboutStylesheets) {
        warnedAboutStylesheets = true;
        console.warn(
          "BookView: could not inline an EPUB stylesheet; the book may render unstyled",
          err
        );
      }
      continue;
    }

    const style = doc.createElementNS(doc.documentElement.namespaceURI ?? XHTML_NS, "style");
    style.setAttribute("type", "text/css");
    // `media` narrows where a stylesheet applies, and dropping it would apply
    // a print-only sheet to the screen.
    const media = link.getAttribute("media");
    if (media) style.setAttribute("media", media);
    // `@charset` is only meaningful at the head of an external stylesheet; left
    // in a <style> it is a parse error, and the rule after it can be taken with
    // it. The document's own encoding already governs this text.
    // A stylesheet may open with a byte-order mark; strip it rather than
    // matching one, which would put an invisible character in the source.
    const text = css.charCodeAt(0) === 0xfeff ? css.slice(1) : css;
    style.textContent = text.replace(/^\s*@charset\s+["'][^"']*["']\s*;/i, "");
    link.replaceWith(style);
  }
}

function isStylesheet(link: Element): boolean {
  const rel = link.getAttribute("rel");
  if (!rel) return false;
  return rel.toLowerCase().split(/\s+/).includes("stylesheet");
}

/** Places the policy first inside `<head>`, where it governs everything after it. */
function insertMeta(doc: Document): void {
  const ns = doc.documentElement.namespaceURI ?? XHTML_NS;
  const meta = doc.createElementNS(ns, "meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", POLICY);

  let head = doc.querySelector("head");
  if (!head) {
    head = doc.createElementNS(ns, "head") as HTMLHeadElement;
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
  }
  head.insertBefore(meta, head.firstChild);
}

/** The text-only fallback, for markup that would not parse. */
function insertMetaAsText(markup: string): string {
  if (/<head[^>]*>/i.test(markup)) return markup.replace(/<head[^>]*>/i, (tag) => tag + META);
  if (/<html[^>]*>/i.test(markup)) {
    return markup.replace(/<html[^>]*>/i, (tag) => tag + "<head>" + META + "</head>");
  }
  return markup;
}
