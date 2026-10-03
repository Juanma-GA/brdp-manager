// Builds the documents of the AI Extract (2/2) fixtures from the two sample
// texts in this folder (guia-estilo-dita-es.md, brexdoc-s1000d-en.md):
//
//   <name>.docx       a Word document: "# "/"## " lines as headings, one
//                     paragraph per block (OOXML written with jszip)
//   <name>.pdf        the same text printed to PDF by Chromium (real text
//                     runs, embedded fonts)
// and, for the edge cases of reading a file:
//   scanned.pdf       a PDF with only an image (no selectable text)
//   protected.pdf     a text PDF encrypted with an open password ("secret";
//                     PDF standard security handler, revision 2, RC4)
//   damaged.docx      the Spanish .docx cut in half (not a valid zip)
//   old-format.doc    a Word 97-2003 file header: the page rejects .doc by
//                     its extension before reading it (LibreOffice Writer,
//                     which could write a real one, is not available here)
//
//     node scripts/prompt-eval/fixtures/text-extract/make-documents.mjs
//
// CHROMIUM_PATH is optional (Playwright's default browser otherwise).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEXTS = ["guia-estilo-dita-es", "brexdoc-s1000d-en"];

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const blocks = (md) => md.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

async function writeDocx(md, target) {
  const paragraph = (text, size, bold) => {
    const props = size || bold ? `<w:rPr>${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/>` : ""}</w:rPr>` : "";
    return `<w:p><w:r>${props}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  };
  const body = blocks(md).map((b) => {
    if (b.startsWith("# ")) return paragraph(b.slice(2), 32, true);
    if (b.startsWith("## ")) return paragraph(b.slice(3), 26, true);
    return paragraph(b.split("\n").join(" "));
  });
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      body.join("") +
      "</w:body></w:document>"
  );
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", date: new Date("2026-10-03T00:00:00Z") });
  fs.writeFileSync(target, data);
  return data;
}

function html(md) {
  const parts = blocks(md).map((b) => {
    if (b.startsWith("# ")) return `<h1>${escapeXml(b.slice(2))}</h1>`;
    if (b.startsWith("## ")) return `<h2>${escapeXml(b.slice(3))}</h2>`;
    return `<p>${escapeXml(b.split("\n").join(" "))}</p>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:serif;font-size:12pt;margin:0}h1{font-size:16pt}h2{font-size:13pt}p{margin:0 0 10pt}</style></head><body>${parts.join("")}</body></html>`;
}

// ── Minimal PDF writer (scanned image page; encrypted text page) ─────────

function pdfFile(objects, trailerExtra = "") {
  const chunks = [Buffer.from("%PDF-1.4\n")];
  let size = chunks[0].length;
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(size);
    const buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(obj) ? obj : Buffer.from(obj, "latin1"), Buffer.from("\nendobj\n")]);
    chunks.push(buf);
    size += buf.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

function scannedPdf(target) {
  const width = 200;
  const height = 60;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels.fill((Math.floor(x / 10) + Math.floor(y / 6)) % 3 === 0 ? 40 : 220, (y * width + x) * 3, (y * width + x) * 3 + 3);
  const image = zlib.deflateSync(pixels);
  const content = "q 400 0 0 120 100 600 cm /Im1 Do Q";
  fs.writeFileSync(
    target,
    pdfFile([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      Buffer.concat([
        Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`),
        image,
        Buffer.from("\nendstream"),
      ]),
    ])
  );
}

// PDF standard security handler, revision 2 (40-bit RC4), algorithms 3.1-3.4
// of the PDF 1.7 reference.
const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
const md5 = (...parts) => crypto.createHash("md5").update(Buffer.concat(parts)).digest();
function rc4(key, data) {
  const s = [...Array(256).keys()];
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const padded = (password) => Buffer.concat([Buffer.from(password, "latin1"), PAD]).subarray(0, 32);

function protectedPdf(lines, target, password) {
  const id = md5(Buffer.from("brdp-manager text-extract fixture"));
  const P = -44; // print and copy allowed, no modify
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);
  const O = rc4(md5(padded("owner-" + password)).subarray(0, 5), padded(password));
  const key = md5(padded(password), O, pBytes, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const objKey = (num) => md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10);
  const winAnsi = (s) => Buffer.from([...s].map((ch) => ch.charCodeAt(0) & 255));
  const pdfString = (b) => b.toString("latin1").replace(/[\\()]/g, (c) => `\\${c}`);
  let y = 780;
  const ops = ["BT", "/F1 11 Tf"];
  for (const line of lines) {
    ops.push(`1 0 0 1 60 ${y} Tm (${pdfString(winAnsi(line))}) Tj`);
    y -= line ? 15 : 10;
  }
  ops.push("ET");
  const content = rc4(objKey(4), Buffer.from(ops.join("\n"), "latin1"));
  const hex = (b) => `<${b.toString("hex")}>`;
  fs.writeFileSync(
    target,
    pdfFile(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        `<< /Filter /Standard /V 1 /R 2 /O ${hex(O)} /U ${hex(U)} /P ${P} >>`,
      ],
      `/Encrypt 6 0 R /ID [${hex(id)} ${hex(id)}] `
    )
  );
}

function wrap(text, width = 80) {
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > width) {
      out.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
}

async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage();
    for (const name of TEXTS) {
      const md = fs.readFileSync(path.join(HERE, `${name}.md`), "utf8");
      await writeDocx(md, path.join(HERE, `${name}.docx`));
      await page.setContent(html(md));
      await page.pdf({ path: path.join(HERE, `${name}.pdf`), format: "A4", margin: { top: "20mm", bottom: "20mm", left: "20mm", right: "20mm" } });
    }
  } finally {
    await browser.close();
  }
  const es = fs.readFileSync(path.join(HERE, `${TEXTS[0]}.md`), "utf8");
  const lines = blocks(es).slice(0, 4).flatMap((b) => [...wrap(b.replace(/^#+ /, "").split("\n").join(" ")), ""]);
  protectedPdf(lines, path.join(HERE, "protected.pdf"), "secret");
  scannedPdf(path.join(HERE, "scanned.pdf"));
  const docx = fs.readFileSync(path.join(HERE, `${TEXTS[0]}.docx`));
  fs.writeFileSync(path.join(HERE, "damaged.docx"), docx.subarray(0, Math.floor(docx.length / 2)));
  fs.writeFileSync(path.join(HERE, "old-format.doc"), Buffer.concat([Buffer.from("D0CF11E0A1B11AE1", "hex"), Buffer.alloc(504)]));
  for (const f of fs.readdirSync(HERE).sort()) {
    if (/\.(docx|pdf|doc)$/.test(f)) console.log(`${f}: ${fs.statSync(path.join(HERE, f)).size} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
