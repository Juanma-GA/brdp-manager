// Throwaway in-browser verification (real Chromium against the real live
// Vite dev server) that the XMetal ambito-mapa vocabulary-lint message
// change works: dosier/ficha/mapa/exists get the expanded, honest message
// instead of the generic "unconfirmed element/attribute" one, while real
// genuine warnings (footnote/video/audio, from the existing curated
// few-shot regression test) are completely unaffected.
//
// NOTE: this does not use the user's real "BRDP-EXT-00004/BRDP-ENV-00001"
// Navantia-XMetal rules / screenshot with 7 warnings -- that file was not
// provided in this environment. Constructed instead from the exact
// vocabulary named in the encargo (dosier/ficha/mapa/exists used in
// context/test XPath), which exercises the same code path. If exact
// reproduction of the real 7-warning screenshot matters, that file needs
// to be attached.
import { chromium } from "playwright-core";

const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console error]", m.text());
  });
  try {
    await page.goto("http://localhost:5173/");
    const result = await page.evaluate(async () => {
      const mod = await import("/src/api/generateSchematronDITA.js");
      // Constructed rule using the real ambito-mapa mechanism's vocabulary
      // (dosier/ficha/mapa navigation + an exists() check), plus one
      // genuinely unconfirmed name ("frobnicate") to prove the two
      // categories don't bleed into each other.
      const ambitoRule =
        '<pattern id="p-BRDP-EXT-00004">' +
        '<rule context="dosier/ficha[mapa]">' +
        '<assert id="BRDP-EXT-00004-a" test="exists(mapa/@href)">Missing mapa/@href.</assert>' +
        '<assert id="BRDP-EXT-00004-b" test="frobnicate and true()">Missing frobnicate (genuinely unconfirmed).</assert>' +
        "</rule>" +
        "</pattern>";
      const envRule =
        '<pattern id="p-BRDP-ENV-00001">' +
        '<rule context="ficha[dosier]">' +
        '<assert id="BRDP-ENV-00001-a" test="exists(dosier/mapa)">Missing dosier/mapa.</assert>' +
        "</rule>" +
        "</pattern>";
      const brdps = [
        { id: "u1", identifier: "BRDP-EXT-00004", validation: "Validated", definition: "d", proposal: "p" },
        { id: "u2", identifier: "BRDP-ENV-00001", validation: "Validated", definition: "d", proposal: "p" },
      ];
      const approvals = new Map([
        ["u1", { brdp_id: "u1", status: "approved", rule_xml: ambitoRule }],
        ["u2", { brdp_id: "u2", status: "approved", rule_xml: envRule }],
      ]);
      const output = await mod.generateSchematronDITA(brdps, { projectName: "XMetal Test" }, {
        onlyValidated: true,
        approvals,
      });
      return { valid: output.valid, errors: output.errors, vocabularyWarnings: output.vocabularyWarnings };
    });
    console.log(JSON.stringify(result, null, 2));

    assert(result.valid === true, "checkWellFormedSchematron reports valid:true");
    const warnings = result.vocabularyWarnings;

    const ambitoWarnings = warnings.filter((w) => /ambito-mapa/.test(w));
    assert(ambitoWarnings.length > 0, "at least one warning uses the expanded ambito-mapa message");
    for (const name of ["dosier", "ficha", "mapa", "exists"]) {
      assert(
        warnings.some((w) => w.includes(`uses '${name}'`) && w.includes("ambito-mapa.sch")),
        `'${name}' gets the expanded ambito-mapa message`
      );
      assert(
        !warnings.some((w) => w.includes(`uses unconfirmed element/attribute '${name}'`)),
        `'${name}' does NOT also get the old generic message`
      );
    }
    assert(
      warnings.some((w) => w.includes("uses unconfirmed element/attribute 'frobnicate'")),
      "a genuinely unconfirmed name still gets the plain generic message, unaffected"
    );
    assert(
      !warnings.some((w) => w.includes("frobnicate") && w.includes("ambito-mapa")),
      "the genuinely unconfirmed name never gets the ambito-mapa text"
    );

    console.log("\nAll ambito-mapa vocabulary-message checks passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
