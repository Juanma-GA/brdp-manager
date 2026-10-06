// Text files read by the checks, the same however git checked them out
// (Protecciones 1c). On Windows git usually writes text files with CRLF
// (core.autocrlf), on Linux with LF; a fixture whose text ends up in a prompt
// or is compared byte by byte must not change with that. .gitattributes
// keeps the fixtures LF on checkout; these readers make the comparison
// independent of it anyway (a copy made by hand, an editor that saves CRLF,
// an old checkout).
//
//   normalizeNewlines(text)  CRLF and lone CR (old Mac) -> LF
//   readTextFile(file)       UTF-8, without a BOM, newlines normalized;
//                            `file` may be a path or a file: URL
//   toPath(file)             a path for fs, path or a child process; never
//                            URL.pathname, which on Windows is "/C:/..."
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

export function toPath(file) {
  if (file instanceof URL) return fileURLToPath(file);
  if (typeof file === 'string' && file.startsWith('file:')) return fileURLToPath(file);
  return file;
}

export function readTextFile(file) {
  return normalizeNewlines(fs.readFileSync(toPath(file), 'utf8').replace(/^\uFEFF/, ''));
}
