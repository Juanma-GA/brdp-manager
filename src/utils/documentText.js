// AI Extract (2/2): the text of a document attached for "Import from text
// or document" -- read in the browser, nothing is uploaded but the text.
//   .txt / .md   as UTF-8 text
//   .docx        mammoth (its raw text: one paragraph per line, a blank
//                line between paragraphs)
//   .pdf         pdf.js: lines from its text items, a blank line where the
//                gap between two lines is clearly larger than a line, or
//                between pages
// Errors carry a code the page translates (DocumentReadError):
//   unsupported   another extension (an old .doc: save it as .docx)
//   pdf_no_text   a PDF without selectable text (scanned)
//   pdf_password  a password-protected PDF
//   unreadable    a damaged file (its reason in `detail`)
// The PDF library is injectable (`loadPdfjs`) so the Node tests use
// pdf.js's legacy build; the page uses the browser build with its worker.

export const DOCUMENT_EXTENSIONS = ['.txt', '.md', '.docx', '.pdf'];

export class DocumentReadError extends Error {
  constructor(code, detail = '') {
    super(detail || code);
    this.code = code;
    this.detail = detail;
  }
}

export function extensionOf(name) {
  const m = /\.[^.]+$/.exec(String(name || '').toLowerCase());
  return m ? m[0] : '';
}

async function browserPdfjs() {
  const pdfjsLib = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjsLib;
}

// The text of one PDF page from its text items (pure): items in reading
// order; a line ends where pdf.js says so (hasEOL) or where the baseline
// moves; a blank line where the vertical gap is over 1.5 lines.
export function pdfPageText(items) {
  const lines = [];
  let current = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform ? item.transform[5] : 0;
    const height = item.height || (item.transform ? Math.abs(item.transform[3]) : 0) || 10;
    if (!current || (Math.abs(current.y - y) > height * 0.5 && item.str.trim())) {
      current = { y, height, text: '' };
      lines.push(current);
    }
    current.text += item.str;
    if (item.hasEOL) current = null;
  }
  const out = [];
  let previous = null;
  for (const line of lines) {
    const text = line.text.replace(/\s+$/, '');
    if (!text.trim()) continue;
    if (previous && Math.abs(previous.y - line.y) > previous.height * 1.5 * 1.15) out.push('');
    out.push(text);
    previous = line;
  }
  return out.join('\n');
}

async function readPdf(data, loadPdfjs) {
  const pdfjsLib = await loadPdfjs();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new DocumentReadError('pdf_password');
    throw new DocumentReadError('unreadable', err?.message || String(err));
  }
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(pdfPageText(content.items));
  }
  const text = pages.filter((p) => p.trim()).join('\n\n');
  if (!text.trim()) throw new DocumentReadError('pdf_no_text');
  return text;
}

async function readDocx(data, loadMammoth) {
  const mammoth = await loadMammoth();
  try {
    const result = await mammoth.extractRawText({ arrayBuffer: data });
    return result.value.replace(/\n{3,}/g, '\n\n').trim();
  } catch (err) {
    throw new DocumentReadError('unreadable', err?.message || String(err));
  }
}

// → the text. `file`: a File / Blob with a name (or { name, arrayBuffer() }).
export async function readDocumentText(file, { loadPdfjs = browserPdfjs, loadMammoth = () => import('mammoth') } = {}) {
  const ext = extensionOf(file.name);
  if (!DOCUMENT_EXTENSIONS.includes(ext)) throw new DocumentReadError('unsupported', ext);
  const data = await file.arrayBuffer();
  if (ext === '.pdf') return readPdf(new Uint8Array(data), loadPdfjs);
  if (ext === '.docx') return readDocx(data, loadMammoth);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  } catch {
    throw new DocumentReadError('unreadable', 'not UTF-8 text');
  }
}
