// Duplicar un proyecto -- in a real browser, against the real backend and
// Postgres (no AI involved):
//   - an admin duplicates a project from the list: the dialog proposes
//     "<name> (copy)", says what is and is not copied, the button is busy
//     while it works, the list shows the copy and the notice opens it;
//   - the copy has the active BRDPs (not the one in the Trash), the Verified
//     rule with its "Tested ✓" indicator up to date, and History with one
//     "Copied from <project>" entry;
//   - a name already used by an active project (other case and accents) is
//     refused in the dialog with its reason, in English and Spanish; nothing
//     is created;
//   - the same in Spanish: "(copia)", the lines and the notice;
//   - an editor of the project sees no Duplicate button;
//   - everything it creates is deleted at the end.
//
//     node scripts/verify-project-duplicate.mjs
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
const RULE = '<structureObjectRule id="DUPV-1"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>Emphasis shall not be used.</objectUse></structureObjectRule>';

let failures = 0;
function assert(condition, message, detail = "") {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const token = (await res.json()).access_token;
  if (!token) throw new Error(`login failed for ${email} (HTTP ${res.status})`);
  return token;
}
function apiAs(token) {
  return async (p, options = {}) => {
    const res = await fetch(`${API}${p}`, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (!res.ok) throw new Error(`${options.method || "GET"} ${p} -> ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
}

async function signIn(page, email, password) {
  await page.goto(BASE_URL);
  await page.fill("#login-email", email);
  await page.fill("#login-password", password);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/projects/);
  await page.locator("table").waitFor();
}

async function main() {
  const token = await login(EMAIL, PASSWORD);
  const api = apiAs(token);
  const me = await api("/api/auth/me");
  const previousLanguage = me.preferred_language;
  const setLanguage = (lang) => api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ preferred_language: lang }) });
  await setLanguage("en");

  const suffix = Date.now().toString(36);
  const sourceName = `Duplicar Ñandú ${suffix}`;
  const created = [];
  let editorId = null;

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  try {
    // ── Seed: a source project with two active BRDPs, one in the Trash, and
    //    a Verified rule with a passed test. ───────────────────────────────
    const source = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: sourceName, standard: "S1000D 4.2" }) });
    created.push(source.id);
    const a = await api(`/api/projects/${source.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier: "BRDP-DUPV-00001", title: "Emphasis", definition: "Decide whether emphasis is used.", proposal: "Emphasis shall not be used.", validation: "Validated" }),
    });
    await api(`/api/projects/${source.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier: "BRDP-DUPV-00002", title: "Tables", definition: "Decide how tables are used." }),
    });
    const trashed = await api(`/api/projects/${source.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier: "BRDP-DUPV-00003", title: "In the Trash" }),
    });
    await api(`/api/projects/${source.id}/brdps/${trashed.id}`, { method: "DELETE" });
    await api(`/api/projects/${source.id}/brdps/${a.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: RULE, status: "approved", source: "manual" }),
    });
    const ruleHash = crypto.createHash("sha256").update(RULE, "utf8").digest("hex");
    await api(`/api/projects/${source.id}/brdps/${a.id}/approvals/BREX-4.2/test`, {
      method: "POST",
      body: JSON.stringify({ result: "passed", rule_hash: ruleHash }),
    });

    // ── English: duplicate from the list ─────────────────────────────────
    console.log("\nAdmin duplicates the project from the list (English)");
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await openHistoryOnEachLoad(page);
    await signIn(page, EMAIL, PASSWORD);
    await page.getByTestId(`duplicate-project-${source.id}`).click();
    const dialog = page.getByTestId("duplicate-project-dialog");
    await dialog.waitFor();
    const nameInput = dialog.locator("#duplicate-project-name");
    assert((await nameInput.inputValue()) === `${sourceName} (copy)`, `name prefilled "${sourceName} (copy)"`, await nameInput.inputValue());
    const dialogText = await dialog.innerText();
    assert(/Copied: the configuration, the BRDPs/.test(dialogText), "line: what is copied");
    assert(/Not copied: History/.test(dialogText), "line: what is not copied");
    await page.screenshot({ path: shot("project-duplicate-dialog-en.png") });

    const copyName = `Copia de prueba ${suffix}`;
    await nameInput.fill(copyName);
    // Hold the request so the busy state is visible.
    let release;
    const held = new Promise((r) => (release = r));
    await page.route("**/api/projects/*/duplicate", async (route) => {
      await held;
      await route.continue();
    });
    await dialog.getByRole("button", { name: "Duplicate" }).click();
    const busy = dialog.locator('button[data-state="busy"]');
    await busy.waitFor();
    assert((await busy.innerText()).includes("Duplicating…") && (await busy.isDisabled()), 'button busy: "Duplicating…", disabled');
    release();
    const done = page.getByTestId("duplicate-project-done");
    await done.waitFor({ timeout: 60000 });
    await page.unroute("**/api/projects/*/duplicate");
    assert((await done.innerText()).includes(`duplicated as "${copyName}"`), "notice names the copy", await done.innerText());
    const copyRow = page.locator("tbody tr", { hasText: copyName });
    await copyRow.waitFor();
    assert(await copyRow.isVisible(), "the list shows the copy");
    const listed = await api("/api/projects");
    const copy = listed.find((p) => p.name === copyName);
    created.push(copy.id);
    assert(copy && copy.standard === "S1000D 4.2", "copy has the source's standard");

    // ── Open the copy ────────────────────────────────────────────────────
    console.log("\nThe copy: BRDPs, rule, test indicator and History");
    await done.getByRole("button", { name: "Open the copy" }).click();
    await page.waitForURL(new RegExp(`/projects/${copy.id}/records`));
    await page.locator("tbody tr", { hasText: "BRDP-DUPV-00001" }).waitFor();
    const rowTexts = await page.locator("tbody tr").allInnerTexts();
    assert(rowTexts.some((t) => t.includes("BRDP-DUPV-00001")) && rowTexts.some((t) => t.includes("BRDP-DUPV-00002")), "both active BRDPs are in the copy");
    assert(!rowTexts.some((t) => t.includes("BRDP-DUPV-00003")), "the BRDP in the Trash is not");
    await page.locator("tbody tr", { hasText: "BRDP-DUPV-00001" }).click();
    const indicator = page.getByTestId("rule-test-indicator");
    await indicator.waitFor();
    assert((await indicator.getAttribute("data-state")) === "passed", "test indicator: passed, up to date", await indicator.getAttribute("data-state"));
    assert((await indicator.innerText()).includes("✓"), `indicator reads "${await indicator.innerText()}"`);
    const historyItem = page.getByTestId("history-item").first();
    await historyItem.waitFor();
    const historyItems = await page.getByTestId("history-item").allInnerTexts();
    assert(historyItems.length === 1, "History has exactly one entry", historyItems.join(" | "));
    assert(/copied from/i.test(historyItems[0]) && historyItems[0].includes(sourceName), `History: "Copied from ${sourceName}"`, historyItems[0]);
    await page.screenshot({ path: shot("project-duplicate-copy-history-en.png") });
    const copyBrdps = await api(`/api/projects/${copy.id}/brdps`);
    assert(copyBrdps.length === 2, "API: the copy has 2 BRDPs");

    // ── Repeated name (other case and accents) ───────────────────────────
    console.log("\nA name already in use is refused in the dialog");
    await page.goto(`${BASE_URL}/projects`);
    await page.getByTestId(`duplicate-project-${source.id}`).click();
    await dialog.waitFor();
    const taken = sourceName.toUpperCase().replace("Ñ", "N").replace("Ú", "U");
    await nameInput.fill(taken);
    await dialog.getByRole("button", { name: "Duplicate" }).click();
    const error = page.getByTestId("duplicate-project-error");
    await error.waitFor();
    const errorText = await error.innerText();
    assert(errorText.includes(`already called "${taken}"`) && /another name for the copy/.test(errorText), "error in English with its reason", errorText);
    assert(!(await api("/api/projects")).some((p) => p.name === taken), "nothing created");
    await page.screenshot({ path: shot("project-duplicate-name-taken-en.png") });
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // ── Spanish ──────────────────────────────────────────────────────────
    console.log("\nSpanish");
    await setLanguage("es");
    await page.reload();
    await page.locator("table").waitFor();
    await page.getByTestId(`duplicate-project-${source.id}`).click();
    await dialog.waitFor();
    assert((await nameInput.inputValue()) === `${sourceName} (copia)`, `name prefilled "${sourceName} (copia)"`, await nameInput.inputValue());
    const dialogEs = await dialog.innerText();
    assert(/Se copian: la configuración/.test(dialogEs) && /No se copian: el Historial/.test(dialogEs), "lines in Spanish");
    await nameInput.fill(copyName.toLowerCase());
    await dialog.getByRole("button", { name: "Duplicar" }).click();
    await error.waitFor();
    const errorEs = await error.innerText();
    assert(errorEs.includes(`Ya hay un proyecto activo llamado "${copyName.toLowerCase()}"`) && /Elige otro nombre para la copia/.test(errorEs), "error in Spanish with its reason", errorEs);
    await page.screenshot({ path: shot("project-duplicate-name-taken-es.png") });
    await nameInput.fill(`${sourceName} (copia)`);
    await dialog.getByRole("button", { name: "Duplicar" }).click();
    await done.waitFor({ timeout: 60000 });
    assert((await done.innerText()).includes(`duplicado como "${sourceName} (copia)"`), "notice in Spanish", await done.innerText());
    assert((await done.getByRole("button").first().innerText()) === "Abrir la copia", '"Abrir la copia"');
    const copyEs = (await api("/api/projects")).find((p) => p.name === `${sourceName} (copia)`);
    created.push(copyEs.id);
    await done.getByRole("button", { name: "Abrir la copia" }).click();
    await page.locator("tbody tr", { hasText: "BRDP-DUPV-00001" }).click();
    await page.getByTestId("history-item").first().waitFor();
    const historyEs = (await page.getByTestId("history-item").allInnerTexts())[0];
    assert(/copiada de/i.test(historyEs) && historyEs.includes(sourceName), `History: "Copiada de ${sourceName}"`, historyEs);
    await page.screenshot({ path: shot("project-duplicate-copy-history-es.png") });
    await context.close();

    // ── An editor sees no Duplicate button ───────────────────────────────
    console.log("\nAn editor of the project");
    const editorEmail = `dup-editor-${suffix}@example.com`;
    const editor = await api("/api/users", { method: "POST", body: JSON.stringify({ email: editorEmail, display_name: "Dup editor" }) });
    editorId = editor.id;
    await api(`/api/users/${editor.id}/project-roles`, { method: "PUT", body: JSON.stringify({ project_id: source.id, role: "editor" }) });
    const editorPassword = `Dup-editor-${suffix}-Aa1!`;
    const editorToken = await login(editorEmail, editor.temporary_password);
    await apiAs(editorToken)("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: editor.temporary_password, new_password: editorPassword }),
    });
    const editorContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const editorPage = await editorContext.newPage();
    await signIn(editorPage, editorEmail, editorPassword);
    await editorPage.locator("tbody tr", { hasText: sourceName }).waitFor();
    assert((await editorPage.getByTestId(`duplicate-project-${source.id}`).count()) === 0, "no Duplicate button for an editor");
    const refused = await fetch(`${API}/api/projects/${source.id}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await login(editorEmail, editorPassword)}` },
      body: JSON.stringify({ name: `Editor copy ${suffix}` }),
    });
    assert(refused.status === 403, `the API refuses an editor: ${refused.status}`);
    await editorContext.close();
  } finally {
    await browser.close();
    for (const id of created.reverse()) {
      await api(`/api/projects/${id}?permanent=true`, { method: "DELETE" }).catch((e) => console.log(`  cleanup: ${e.message}`));
    }
    if (editorId) {
      await api(`/api/users/${editorId}`, { method: "DELETE" }).catch(() => {});
      await api(`/api/users/${editorId}/permanent`, { method: "DELETE" }).catch((e) => console.log(`  cleanup: ${e.message}`));
    }
    await setLanguage(previousLanguage ?? "en").catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
