// Generates test EPUBs. Entries are stored uncompressed, which keeps the zip
// writer to one small function and is what the OCF spec requires for `mimetype`
// anyway.
//
//   node test/make-epub.mjs                       -> vertical.epub, vertical-rl + rtl spine
//   node test/make-epub.mjs --vertical= --dir=ltr --out=horizontal.epub
//   node test/make-epub.mjs --toc= --out=notoc.epub   -> no navigation document
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const VERTICAL = arg("vertical", "1") !== "";
const DIR = arg("dir", VERTICAL ? "rtl" : "ltr");
const TOC = arg("toc", "1") !== "";
const OUT = arg("out", VERTICAL ? "vertical.epub" : "horizontal.epub");

/* ------------------------------------------------------------------- zip -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A store-only zip. `entries[0]` must be the `mimetype`. */
function storeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* ------------------------------------------------------------------ book -- */

const text = (s) => Buffer.from(s, "utf8");

const JAPANESE = [
  "吾輩は猫である。名前はまだ無い。どこで生れたか頓と見当がつかぬ。",
  "何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。",
  "吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。",
  "この書生というのは時々我々を捕えて煮て食うという話である。",
  "しかしその当時は何という考もなかったから別段恐しいとも思わなかった。",
  "ただ彼の掌に載せられてスーと持ち上げられた時何だかフワフワした感じがあったばかりである。",
];

const LATIN = [
  "To Sherlock Holmes she is always the woman.",
  "I have seldom heard him mention her under any other name.",
  "In his eyes she eclipses and predominates the whole of her sex.",
  "It was not that he felt any emotion akin to love for Irene Adler.",
  "All emotions, and that one particularly, were abhorrent to his cold mind.",
  "He was, I take it, the most perfect reasoning machine the world has seen.",
];

const CHAPTERS = VERTICAL
  ? ["第一章　書生との出会い", "第二章　薬缶のような顔", "第三章　片輪の猫"]
  : ["I. A Scandal in Bohemia", "II. The Red-Headed League", "III. A Case of Identity"];

/** Enough paragraphs per chapter that a chapter spans several screens. */
function body(seed) {
  const source = VERTICAL ? JAPANESE : LATIN;
  const ruby = VERTICAL ? "<ruby>漢字<rt>かんじ</rt></ruby>のルビも確認する。" : "";
  return Array.from({ length: 28 }, (_, i) => {
    const line = source[(seed * 5 + i) % source.length];
    return `  <p>${line}${ruby}段落番号は${i + 1}。</p>`;
  }).join("\n");
}

const chapter = (title, inner) =>
  text(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"
      xml:lang="${VERTICAL ? "ja" : "en"}">
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body epub:type="bodymatter">
  <h1>${title}</h1>
${inner}
</body>
</html>`);

const STYLE = VERTICAL
  ? `@charset "UTF-8";
html {
  -epub-writing-mode: vertical-rl;
  -webkit-writing-mode: vertical-rl;
  writing-mode: vertical-rl;
  font-family: "Yu Mincho", "Hiragino Mincho ProN", serif;
}
body { margin: 0; }
h1 { font-size: 1.4em; margin: 0 0 1em 0; font-weight: normal; }
p { margin: 0; text-indent: 1em; }
ruby > rt { font-size: 0.5em; }
`
  : `@charset "UTF-8";
body { margin: 0; font-family: Georgia, serif; }
h1 { font-size: 1.4em; margin: 0 0 1em 0; font-weight: normal; }
p { margin: 0 0 0.6em 0; text-indent: 1.2em; }
`;

const manifest = CHAPTERS.map(
  (_, i) => `    <item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
).join("\n");
const spine = CHAPTERS.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join("\n");

const files = [
  // Must come first, and stored, per the OCF spec.
  { name: "mimetype", data: text("application/epub+zip") },
  {
    name: "META-INF/container.xml",
    data: text(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
  },
  {
    name: "OEBPS/content.opf",
    data: text(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"
         xml:lang="${VERTICAL ? "ja" : "en"}"
         prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:bookview-test-${VERTICAL ? "vertical" : "horizontal"}</dc:identifier>
    <dc:title>${VERTICAL ? "縦書きテスト書籍" : "BookView Test Book"}</dc:title>
    <dc:language>${VERTICAL ? "ja" : "en"}</dc:language>
    <dc:creator>${VERTICAL ? "夏目 漱石" : "Arthur Conan Doyle"}</dc:creator>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
    <meta property="rendition:layout">reflowable</meta>
  </metadata>
  <manifest>
${TOC ? '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' : ""}    <item id="css" href="style.css" media-type="text/css"/>
${manifest}
  </manifest>
  <spine page-progression-direction="${DIR}">
${spine}
  </spine>
</package>`),
  },
  { name: "OEBPS/style.css", data: text(STYLE) },
  ...CHAPTERS.map((title, i) => ({
    name: `OEBPS/ch${i + 1}.xhtml`,
    data: chapter(title, body(i)),
  })),
];

if (TOC) {
  files.splice(3, 0, {
    name: "OEBPS/nav.xhtml",
    data: text(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="UTF-8"/><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${VERTICAL ? "目次" : "Contents"}</h1>
    <ol>
${CHAPTERS.map((t, i) => `      <li><a href="ch${i + 1}.xhtml">${t}</a></li>`).join("\n")}
    </ol>
  </nav>
</body>
</html>`),
  });
}

const out = path.join(here, OUT);
await fs.writeFile(out, storeZip(files));
console.log(
  `wrote ${path.relative(process.cwd(), out)} — ` +
    `${VERTICAL ? "vertical-rl" : "horizontal"}, spine ${DIR}, ` +
    `${CHAPTERS.length} chapters, ${TOC ? "with" : "no"} nav`
);
