// AACF 3, Part 3 (HR15/HR21): no raw token reaches the screen.
//
// - every error code the backend sends (error_detail("x"), and the codes of
//   ExcelFileError / RuleExtractFileError) is a known code with its own EN
//   and ES sentence;
// - roles, the "context"/"test" labels of Comparar and the Suggest
//   reference source read in both languages, an unknown role as it is.
//
// Run: node scripts/test-aacf3-texts.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import i18n from "../src/i18n/index.js";
import { KNOWN_CODES, describeErrorDetail } from "../src/services/apiErrors.js";
import { roleLabel } from "../src/utils/roles.js";
import { referenceSourceLabel } from "../src/utils/referenceSource.js";

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "OK" : "FAIL"}: ${label}${!ok && extra ? ` -- ${extra}` : ""}`);
  if (!ok) failures += 1;
};
const en = i18n.getFixedT("en");
const es = i18n.getFixedT("es");

// Codes the backend sends, read from its source (never a hand-kept list).
function backendCodes() {
  const codes = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__pycache__") walk(path);
      } else if (entry.name.endsWith(".py")) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/error_detail\(\s*"([a-z0-9_]+)"/g)) codes.add(m[1]);
        // ExcelFileError("…", "code") / RuleExtractFileError("…", "code"):
        // the code is the second positional string.
        for (const m of text.matchAll(/(?:ExcelFileError|RuleExtractFileError)\(\s*(?:f?"(?:[^"\\]|\\.)*"\s*,\s*)+?"([a-z0-9_]+)"/g)) codes.add(m[1]);
      }
    }
  };
  walk("backend/app");
  return codes;
}
const sent = backendCodes();
check(`backend codes found (${sent.size})`, sent.size > 40);
for (const code of [...sent].sort()) {
  const known = KNOWN_CODES.has(code);
  const textEn = en(`errors.codes.${code}`);
  const textEs = es(`errors.codes.${code}`);
  check(
    `${code}: known, EN and ES sentences`,
    known && textEn !== `errors.codes.${code}` && textEs !== `errors.codes.${code}` && textEn !== textEs,
    `${known} | ${textEn} | ${textEs}`
  );
}
for (const code of KNOWN_CODES) {
  check(`${code}: EN and ES text exist`, en(`errors.codes.${code}`) !== `errors.codes.${code}` && es(`errors.codes.${code}`) !== `errors.codes.${code}`);
}

// A coded detail reads in the interface language, with its params, never
// the English message the server keeps next to it.
const detail = { code: "brdp_identifier_taken", identifier: "BRDP-X-1", message: "A BRDP with identifier 'BRDP-X-1' already exists in this project" };
check("coded detail in EN", describeErrorDetail(409, detail, en) === "A BRDP with the identifier BRDP-X-1 already exists in this project.", describeErrorDetail(409, detail, en));
check("coded detail in ES", describeErrorDetail(409, detail, es) === "Ya existe un BRDP con el identificador BRDP-X-1 en este proyecto.", describeErrorDetail(409, detail, es));
const excel = { code: "excel_too_large", size: 120, limit: 100, message: "The file is 120 bytes, over the 100-byte limit." };
check("Excel limit in ES", describeErrorDetail(422, excel, es) === "El fichero ocupa 120 bytes, por encima del límite de 100 bytes.", describeErrorDetail(422, excel, es));
check("unknown code: the server's English message", describeErrorDetail(400, { code: "something_new", message: "Something new happened" }, es) === "Something new happened");

// Roles.
for (const [role, textEn, textEs] of [
  ["admin", "Administrator", "Administrador"],
  ["user", "User", "Usuario"],
  ["editor", "Editor", "Editor"],
  ["viewer", "Viewer", "Lector"],
]) {
  check(`role ${role}: EN ${textEn}, ES ${textEs}`, roleLabel(en, role) === textEn && roleLabel(es, role) === textEs, `${roleLabel(en, role)} / ${roleLabel(es, role)}`);
}
check("unknown role shown raw", roleLabel(es, "auditor") === "auditor");
check("no role: empty", roleLabel(es, null) === "");

// Comparar: context / test.
check("Compare labels EN", en("records.compare.structContext") === "context" && en("records.compare.structTest") === "test");
check("Compare labels ES", es("records.compare.structContext") === "contexto" && es("records.compare.structTest") === "condición");

// Suggest reference source.
const records = { source_type: "records", source_project: "Lufthansa", source: "Records: Lufthansa" };
check("Records source EN", referenceSourceLabel(en, records) === "Records: Lufthansa");
check("Records source ES", referenceSourceLabel(es, records) === "Registros: Lufthansa");
check("Catalog source ES", referenceSourceLabel(es, { source_type: "catalog", source_project: "" }) === "Catálogo");
check("Template source ES", referenceSourceLabel(es, { source_type: "template", source_project: "" }) === "Plantilla");
check("Another project: its name", referenceSourceLabel(es, { source_type: "project", source_project: "Navantia" }) === "Navantia");
check("This project: nothing", referenceSourceLabel(es, { source_type: "", source_project: "" }) === "");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
