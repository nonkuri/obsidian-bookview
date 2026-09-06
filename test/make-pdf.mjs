// Generates a test PDF: 5 A5 pages, plus Japanese text through the predefined
// UniJIS-UCS2-H CMap so the inlined CMap tables actually get exercised.
//
//   node test/make-pdf.mjs                                  -> sample.pdf, /TwoPageRight + R2L
//   node test/make-pdf.mjs --layout=OneColumn --direction=  -> what most real PDFs declare
//   node test/make-pdf.mjs --layout= --out=plain.pdf        -> no layout hints at all
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const LAYOUT = arg("layout", "TwoPageRight");
const DIRECTION = arg("direction", "R2L");
const OUT = arg("out", "sample.pdf");

const PAGES = 5;
const W = 420;
const H = 595;

const utf16beHex = (s) => {
  let out = "";
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, "0");
  return out.toUpperCase();
};

const objects = [];
const add = (body) => {
  objects.push(body);
  return objects.length; // 1-based object number
};

// Reserve numbers in a fixed order so references are easy to write.
const catalogNum = 1;
const pagesNum = 2;
const latinFontNum = 3;
const cjkFontNum = 4;
const cidFontNum = 5;
const firstPageNum = 6;
const pageNums = [];
for (let i = 0; i < PAGES; i++) pageNums.push(firstPageNum + i * 2);

add(
  `<< /Type /Catalog /Pages ${pagesNum} 0 R` +
    (LAYOUT ? ` /PageLayout /${LAYOUT}` : "") +
    (DIRECTION ? ` /ViewerPreferences << /Direction /${DIRECTION} >>` : "") +
    ` >>`
);
add(
  `<< /Type /Pages /Count ${PAGES} /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] ` +
    `/MediaBox [0 0 ${W} ${H}] >>`
);
add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
add(
  `<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H ` +
    `/DescendantFonts [${cidFontNum} 0 R] >>`
);
add(
  `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular ` +
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /DW 1000 >>`
);

for (let i = 1; i <= PAGES; i++) {
  const label = i === 1 ? "COVER" : `PAGE ${i}`;
  const jp = utf16beHex(`${i}ページ目・縦書き右綴じ`);
  const stream = [
    `q 0.85 0.85 0.9 rg 0 0 ${W} ${H} re f Q`,
    `q 2 w 0.2 0.2 0.3 RG 10 10 ${W - 20} ${H - 20} re S Q`,
    `BT /F1 34 Tf 0 0 0 rg 40 ${H - 90} Td (${label}) Tj ET`,
    `BT /F2 22 Tf 40 ${H - 150} Td <${jp}> Tj ET`,
    `BT /F1 90 Tf 0.6 0.6 0.7 rg 40 ${H - 300} Td (${i}) Tj ET`,
  ].join("\n");
  const contentsNum = firstPageNum + (i - 1) * 2 + 1;
  add(
    `<< /Type /Page /Parent ${pagesNum} 0 R /Resources << /Font << /F1 ${latinFontNum} 0 R ` +
      `/F2 ${cjkFontNum} 0 R >> >> /Contents ${contentsNum} 0 R >>`
  );
  add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
}

let pdf = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
const offsets = [0];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf, "latin1"));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefOffset = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

const out = path.join(here, OUT);
await fs.writeFile(out, Buffer.from(pdf, "latin1"));
console.log(`wrote ${out} (${PAGES} pages, PageLayout=${LAYOUT || "none"}, Direction=${DIRECTION || "none"})`);
