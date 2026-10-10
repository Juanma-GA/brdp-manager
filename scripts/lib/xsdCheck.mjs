// XSD validation for the browser scripts with xmllint-wasm (a dependency
// already), instead of the xmllint program, which Windows does not have
// (Protecciones 1c). The other .xsd files of the schema's folder are
// preloaded, so its includes/imports resolve.
//
//   await xsdCheck(xsdPath, xml) -> "valid" or the errors (text, cut at 800)
import fs from 'node:fs';
import path from 'node:path';
import { validateXML } from 'xmllint-wasm';

export async function xsdCheck(xsdPath, xml) {
  const dir = path.dirname(xsdPath);
  const main = path.basename(xsdPath);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.xsd'))
    .map((f) => ({ fileName: f, contents: fs.readFileSync(path.join(dir, f), 'utf8') }));
  const result = await validateXML({
    xml: { fileName: 'document.xml', contents: xml },
    schema: files.find((f) => f.fileName === main),
    preload: files.filter((f) => f.fileName !== main),
  });
  if (result.valid) return 'valid';
  return result.errors.map((e) => e.rawMessage || e.message || String(e)).join('\n').slice(0, 800);
}
