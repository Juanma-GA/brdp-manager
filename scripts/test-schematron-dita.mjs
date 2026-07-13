// Manual, standalone test for generateSchematronDITA.js -- runs in plain Node,
// no Vite/browser needed. Not part of the app, not wired into the UI.
//
// Usage (from anywhere -- all paths below are resolved relative to this
// script's own location via import.meta.url, not the current working
// directory, so `node scripts/test-schematron-dita.mjs` from the repo root
// works the same as running it from inside scripts/):
//   BRDP_API_KEY=sk-ant-... BRDP_MODEL=claude-sonnet-4-5-20250929 \
//   node scripts/test-schematron-dita.mjs
//
// Optional env vars:
//   BRDP_PROVIDER=Anthropic|OpenAI|Mistral|Custom   (default Anthropic)
//   BRDP_CUSTOM_ENDPOINT=https://...                (only for Custom/self-hosted)
//
// Methodology: since ALL 29 "A - Estructura XML" BRDPs in the curated 100-row
// xlsx are already used as few-shot examples (0 unused real "A" BRDPs remain
// in that file -- confirmed by re-checking the classified sheet), this test
// uses a LEAVE-ONE-OUT approach instead: 3 real, human-curated, oXygen-
// validated BRDPs are temporarily removed from the few-shot block sent to the
// LLM, then the generator is asked to produce rules for those same 3 BRDPs as
// if they were unseen. The real curated answer for each is printed alongside
// so generalization quality can be judged directly, not just "does it run".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSchematronDITA } from "../src/api/generateSchematronDITA.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const apiKey = process.env.BRDP_API_KEY;
const modelName = process.env.BRDP_MODEL;
const provider = process.env.BRDP_PROVIDER || "Anthropic";
const customEndpoint = process.env.BRDP_CUSTOM_ENDPOINT || "";

if (!apiKey || !modelName) {
  console.error("Missing BRDP_API_KEY and/or BRDP_MODEL environment variables.");
  console.error("Example: BRDP_API_KEY=sk-ant-... BRDP_MODEL=claude-sonnet-4-5-20250929 node scripts/test-schematron-dita.mjs");
  process.exit(1);
}

// ---- held-out BRDPs (real, from sources/D1.3fewshot/schematron-dita-fewshot-draft.json) ----
const HELD_OUT_IDS = ["BRDP-D1-00017", "BRDP-D1-00031", "BRDP-D1-00172"];

const testBRDPs = [
  {
    id: "BRDP-D1-00017",
    definition: "List the verification types and decide on how the quality assurance will be marked and/or indicated. Decide the deliverables that shall be marked.",
    proposal: `Discard what is not never need.
(e.g.:
<map>
    <topicmeta>
        <data name="quality-assurance" value="unverified"/>
    </topicmeta>

Values for S1000D projects: Unverified, tabletop, onObject, tableTopAndOnObject.
`,
    validation: "Validated",
  },
  {
    id: "BRDP-D1-00031",
    definition: "Decide where to use danger, warning, caution and notice, and how they look like. ",
    proposal: "General to all task topics shall be included in the safety requirements section.\nThe look: the simplest one for maintanability.",
    validation: "Validated",
  },
  {
    id: "BRDP-D1-00172",
    definition: "Decide whether and how to use the text element <footnote> and when used, decide whether the use of footnotes is limited to regular text and titles (inline) and/or to tables (table footnotes).",
    proposal: `<footnote> shall not be used.

El elemento <footnote> contiene referencias bibliográficas o explicaciones
que ocuparían demasiado espacio para el lector en el texto.
El elemento <footnote> es una nota a pie de página y suele generar un marcador (por ejemplo, un número en superíndice) en el lugar del flujo de texto en el que aparece.

(e.g.: <p>
    The hydraulic pump is installed on the left side of the engine
    <fn>This configuration applies only to the primary system.</fn>.
</p>)

For reusing:
<fn id="fn-certification">
    Only certified operators may perform this procedure.
</fn>
----
<p>
    This step requires special authorization <fn conref="#fn-certification"/>.
</p>`,
    validation: "Validated",
  },
];

// ---- load real schema summary, then strip the 3 held-out examples ----
const schemaSummaryPath = path.join(REPO_ROOT, "public/schematron-dita-schema-summary.json");
const fullSchemaSummary = JSON.parse(fs.readFileSync(schemaSummaryPath, "utf8"));
const schemaSummary = {
  ...fullSchemaSummary,
  few_shot_examples: fullSchemaSummary.few_shot_examples.filter(
    (ex) => !HELD_OUT_IDS.includes(ex.id)
  ),
};
console.log(
  `Loaded schema summary: ${fullSchemaSummary.few_shot_examples.length} few-shots total, ` +
  `${schemaSummary.few_shot_examples.length} after holding out ${HELD_OUT_IDS.join(", ")}.`
);

// ---- minimal provider-agnostic non-streaming callLLM, Node fetch only ----
function endpointFor(provider, customEndpoint) {
  if (customEndpoint && customEndpoint.trim()) {
    const base = customEndpoint.trim().replace(/\/$/, "");
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }
  if (provider === "OpenAI") return "https://api.openai.com/v1/chat/completions";
  if (provider === "Mistral") return "https://api.mistral.ai/v1/chat/completions";
  return "https://api.anthropic.com/v1/messages";
}

async function callLLM(system, user) {
  const endpoint = endpointFor(provider, customEndpoint);
  const headers = { "content-type": "application/json" };
  let body;
  if (provider === "Anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = { model: modelName, max_tokens: 8000, temperature: 1, system, messages: [{ role: "user", content: user }] };
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
    body = {
      model: modelName, max_tokens: 8000, temperature: 1,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
  }

  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM call failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return provider === "Anthropic" ? data.content[0].text : data.choices[0].message.content;
}

// ---- run ----
const projectConfig = { projectName: "Test Project", modelIdentCode: "TESTPROJ" };

console.log(`\nGenerating Schematron for ${testBRDPs.length} held-out BRDPs (provider=${provider}, model=${modelName})...\n`);

const result = await generateSchematronDITA(testBRDPs, projectConfig, {
  onlyValidated: false,
  schemaSummary,
  callLLM,
});

console.log("=== RESULT ===");
console.log("valid:", result.valid);
console.log("brdpCount:", result.brdpCount);
if (result.errors?.length) {
  console.log("errors:");
  result.errors.forEach((e) => console.log("  -", e));
}
if (result.vocabularyWarnings?.length) {
  console.log("vocabularyWarnings (non-blocking):");
  result.vocabularyWarnings.forEach((w) => console.log("  -", w));
}

console.log("\n=== GENERATED .sch ===\n");
console.log(result.xml);

const outPath = path.join(__dirname, "schematron-dita-test-output.sch");
fs.writeFileSync(outPath, result.xml, "utf8");
console.log(`\nWritten to ${outPath}`);

// ---- print the real curated answers for side-by-side comparison ----
const fewshotPath = path.join(REPO_ROOT, "sources/D1.3fewshot/schematron-dita-fewshot-draft.json");
const curated = JSON.parse(fs.readFileSync(fewshotPath, "utf8")).fewshots;
console.log("\n=== REAL CURATED ANSWERS (ground truth, oXygen-validated) ===\n");
for (const id of HELD_OUT_IDS) {
  const ex = curated.find((e) => e.id === id);
  if (!ex) continue;
  console.log(`--- ${id} ---`);
  console.log(`context: ${ex.context}`);
  console.log(`assert_role: ${ex.assert_role}`);
  console.log(`test: ${ex.test}`);
  console.log(`message: ${ex.message}`);
  console.log(`notes: ${ex.notes}`);
  console.log();
}
