// Verification for "Barrido final 2/2" against the real app (Vite + uvicorn
// + Postgres; the LLM only through the local simulators
// mock-mistral-chat-server.mjs / mock-mistral-embed-server.mjs, uvicorn with
// MISTRAL_ENDPOINT / MISTRAL_EMBED_ENDPOINT pointing at them). Cleans up the
// project it creates.
//   Part 2 -- the lint's warnings in the Test rule panel (duplicate value,
//             flag 1 with a value filter) and under a pasted rule
//             ("cannot reject", "must not" but allowed), never blocking;
//   Part 3 -- <para/@id> passes, <para/@noexiste> warns the attribute,
//             <noexiste/@id> the element, <para/@infoCode> "has no
//             attribute", EN and ES;
//   Part 4 -- Ask answers from the schema with every "+N more" expanded: no
//             line starts with a comma, at 31 widths of the detail panel;
//   Part 5 -- the Excel preview in Spanish: Título/Definición for the
//             catalog override, the rejected row's reason names the Excel
//             column ("la columna Rule Status").
// Run: node scripts/verify-barrido-final-2.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE_URL = 'http://localhost:5173';
const API = 'http://localhost:8000';
const MOCK = 'http://localhost:8902';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || 'AdminTest123!';
const SHOTS = path.join(os.tmpdir(), 'barrido-final-2');
fs.mkdirSync(SHOTS, { recursive: true });

function assert(cond, msg, detail = '') {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail ? `\n  ${detail}` : ''}`);
  console.log('OK:', msg);
}

const token = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
}).then(async (r) => {
  if (!r.ok) throw new Error(`login failed (HTTP ${r.status})`);
  return (await r.json()).access_token;
});
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = (url, init = {}) => fetch(`${API}${url}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
const suffix = Math.random().toString(36).slice(2, 8);
const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Barrido 2 ${suffix}`, standard: 'S1000D 4.2' }) }).then((r) => r.json());
const makeBrdp = (body) =>
  api(`/api/projects/${project.id}/brdps`, { method: 'POST', body: JSON.stringify({ definition: '', proposal: '', validation: 'Pending', ...body }) }).then((r) => r.json());
const putRule = async (brdp, rule_xml) => {
  const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, { method: 'PUT', body: JSON.stringify({ rule_xml, source: 'manual' }) });
  if (!r.ok) throw new Error(`rule PUT ${r.status} ${await r.text()}`);
};

const sor = (id, path, flag, use, extra = '') =>
  `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="${flag}">${path}</objectPath><objectUse>${use}</objectUse>${extra}</structureObjectRule>`;
const ov = (v) => `<objectValue valueForm="single" valueAllowed="${v}"/>`;

await makeBrdp({ identifier: 'BRDP-B2-PAIR-OK', title: 'Write <para/@id> on every paragraph' });
await makeBrdp({ identifier: 'BRDP-B2-PAIR-ATTR', title: 'Use <para/@noexiste>' });
await makeBrdp({ identifier: 'BRDP-B2-PAIR-EL', title: 'Use <noexiste/@id>' });
await makeBrdp({ identifier: 'BRDP-B2-PAIR-NOT', title: 'Use <para/@infoCode>' });
const dup = await makeBrdp({ identifier: 'BRDP-B2-DUP', title: 'Emphasis types', definition: 'Which emphasis types.', proposal: 'Only em01 and em02.', validation: 'Validated' });
await putRule(dup, sor('R-DUP', '//@emphasisType', '2', 'Emphasis types em01 and em02 only.', ov('em01') + ov('em02') + ov('em01')));
const flag1 = await makeBrdp({ identifier: 'BRDP-B2-FLAG1', title: 'Assembly code', definition: 'Assembly code format.', proposal: 'Two digits.', validation: 'Validated' });
await putRule(flag1, sor('R-FLAG1', "//@assyCode[matches(., '^\\d{2}$')]", '1', 'The assembly code is two digits.'));
await makeBrdp({ identifier: 'BRDP-B2-PASTE', title: 'Emphasis', definition: 'Use of emphasis.', proposal: 'Emphasis shall not be used.', validation: 'Validated' });
await makeBrdp({ identifier: 'BRDP-B2-ASK', title: 'Ask about the schema' });

// Suggest Rule needs every pending embedding computed (the simulator).
{
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: 'POST' }).then((r) => r.json());
  for (let i = 0; i < 300; i += 1) {
    const status = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (status.status !== 'running') {
      if (status.status !== 'completed') throw new Error(`embedding job ${status.status}: ${status.error}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const language = () => page.locator('header select, nav select').first();
async function select(identifier) {
  await page.getByPlaceholder(/Search|Buscar/).first().fill(identifier);
  await page.locator('tbody tr', { hasText: identifier }).first().click();
  await page.waitForSelector('text=/BRDP Assistant|Asistente de BRDP/i', { timeout: 5000 });
  await page.waitForTimeout(500);
}
const banner = () => page.locator('[class*="vocabNotice"]').first();

try {
  await page.goto(BASE_URL);
  await page.fill('#login-email', ADMIN_EMAIL);
  await page.fill('#login-password', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('table', { timeout: 10000 });
  await language().selectOption('en');
  await page.goto(`${BASE_URL}/projects/${project.id}/records`);
  await page.waitForSelector('tbody tr', { timeout: 20000 });

  // ─── Part 3: <element/@attribute> ────────────────────────────────────
  console.log('\nPart 3');
  await select('BRDP-B2-PAIR-OK');
  assert((await page.locator('[class*="vocabWarning"]').count()) === 0, '<para/@id>: no warning (before: "<id> is not an element")');
  await select('BRDP-B2-PAIR-ATTR');
  let text = await banner().innerText();
  assert(/@noexiste/.test(text) && !/<noexiste>/.test(text), '<para/@noexiste>: the attribute is warned', text);
  await select('BRDP-B2-PAIR-EL');
  text = await banner().innerText();
  assert(/<noexiste>/.test(text) && !/@id/.test(text), '<noexiste/@id>: the element is warned', text);
  await select('BRDP-B2-PAIR-NOT');
  await page.waitForSelector('text=/has no attribute @infoCode/', { timeout: 8000 });
  text = await banner().innerText();
  assert(text.includes('<para> has no attribute @infoCode in the S1000D 4.2 schema.'), '<para/@infoCode>: "<para> has no attribute @infoCode"', text);
  await language().selectOption('es');
  await page.waitForTimeout(400);
  text = await banner().innerText();
  assert(text.includes('<para> no tiene el atributo @infoCode en el esquema de S1000D 4.2.'), 'same in Spanish', text);
  await banner().screenshot({ path: path.join(SHOTS, 'part3-attribute-not-on-element-es.png') });
  await language().selectOption('en');

  // ─── Part 2: lint warnings while working the rule ─────────────────────
  console.log('\nPart 2');
  const lintWarnings = async () => (await page.getByTestId('rule-lint-warning').allInnerTexts()).map((s) => s.trim());
  await select('BRDP-B2-DUP');
  await fetch(`${MOCK}/reset`, { method: 'POST' });
  await page.getByRole('button', { name: 'Test rule' }).click();
  await page.getByTestId('rule-test-panel').waitFor({ timeout: 10000 });
  let warnings = await lintWarnings();
  assert(
    warnings.length === 1 && warnings[0] === '⚠ The same allowed value is listed more than once: R-DUP: listed more than once: em01 (2 times)',
    'Test rule panel: the duplicate value',
    warnings.join(' | '),
  );
  await page.getByTestId('rule-test-panel').screenshot({ path: path.join(SHOTS, 'part2-test-panel-duplicate.png') });
  await page.getByRole('button', { name: 'Close' }).first().click();
  await select('BRDP-B2-FLAG1');
  await page.getByRole('button', { name: 'Test rule' }).click();
  await page.getByTestId('rule-test-panel').waitFor({ timeout: 10000 });
  warnings = await lintWarnings();
  assert(warnings.length === 1 && warnings[0].startsWith('⚠ Flag 1 with a value filter: a wrong value is never rejected: R-FLAG1:'), 'Test rule panel: flag 1 with a value filter', warnings.join(' | '));
  await page.getByRole('button', { name: 'Close' }).first().click();

  await select('BRDP-B2-PASTE');
  await fetch(`${MOCK}/reset`, { method: 'POST' });
  await page.getByRole('button', { name: 'Suggest Rule' }).click();
  await page.getByRole('button', { name: 'Discard' }).waitFor({ timeout: 15000 });
  await page.getByPlaceholder(/Paste/).fill(sor('R-PASTE', '//emphasis', '2', 'Emphasis must not be used.'));
  await page.waitForTimeout(600);
  warnings = await lintWarnings();
  const pastedWarnings = warnings.filter((w) => /R-PASTE|reject any document/.test(w));
  assert(pastedWarnings.some((w) => w.startsWith('⚠ This rule cannot reject any document')), 'pasted rule: "cannot reject"', warnings.join(' | '));
  assert(pastedWarnings.some((w) => w.startsWith('⚠ The rule says "must not", but it allows it: R-PASTE: says "Emphasis must not be used."')), 'pasted rule: "must not" but allowed', warnings.join(' | '));
  assert(await page.getByRole('button', { name: 'Accept pasted rule' }).isEnabled(), 'the warnings never block Accept');
  await language().selectOption('es');
  await page.waitForTimeout(400);
  warnings = await lintWarnings();
  assert(warnings.some((w) => w.startsWith('⚠ La regla dice «no debe», pero lo permite: R-PASTE: dice «Emphasis must not be used.»')), 'same in Spanish', warnings.join(' | '));
  await page.getByTestId('rule-lint-warning').last().locator('xpath=..').screenshot({ path: path.join(SHOTS, 'part2-pasted-rule-es.png') });
  await page.getByRole('button', { name: /Descartar/ }).first().click();
  await language().selectOption('en');

  // ─── Part 4: no line starts with a comma ─────────────────────────────
  console.log('\nPart 4');
  await select('BRDP-B2-ASK');
  async function ask(question) {
    await fetch(`${MOCK}/reset`, { method: 'POST' });
    const box = page.locator('label', { hasText: /Ask a question|Haz una pregunta/ }).locator('xpath=following::textarea[1]');
    await box.fill(question);
    await box.press('Enter');
    await page.getByTestId('ask-answer-deterministic').waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
  }
  // Commas that start a line: the comma's box sits at the left edge of its
  // line box (the paragraph or list item's content edge).
  const commasAtLineStart = () =>
    page.evaluate(() => {
      const root = document.querySelector('[class*="answerBox"]');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const bad = [];
      let commas = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = node.data.indexOf(','); i >= 0; i = node.data.indexOf(',', i + 1)) {
          commas += 1;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          const block = node.parentElement.closest('p, li, div');
          const left = block.getBoundingClientRect().left + parseFloat(getComputedStyle(block).paddingLeft);
          if (r.width > 0 && r.left - left < 2) bad.push(node.data.slice(Math.max(0, i - 10), i + 10));
        }
      }
      return { commas, bad };
    });
  async function expandAll() {
    const more = page.locator('[data-testid^="answer-more-"]:not([data-testid^="answer-more-list-"])');
    while ((await more.count()) > 0) await more.first().click();
  }
  const divider = page.getByTestId('records-split-divider');
  for (const question of ['Which elements have @changeMark?', 'Where can <para> go?']) {
    await ask(question);
    await expandAll();
    let checked = 0;
    let commas = 0;
    await divider.focus();
    await divider.press('End'); // narrowest detail panel
    for (let step = 0; step <= 30; step += 1) {
      const res = await commasAtLineStart();
      commas = Math.max(commas, res.commas);
      assert(res.bad.length === 0 || false, `"${question}" width step ${step}: no line starts with a comma`, res.bad.join(' | '));
      checked += 1;
      await divider.press('ArrowLeft');
      await page.waitForTimeout(60);
    }
    assert(checked === 31 && commas > 20, `"${question}": ${checked} widths, ${commas} commas checked`);
    await divider.press('Enter');
  }
  await page.locator('[class*="answerBox"]').first().screenshot({ path: path.join(SHOTS, 'part4-expanded-list.png') });
  // Keyboard still opens a name (the names are now inline elements).
  await page.locator('[data-testid^="schema-link-"]').first().focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('schema-nav-card').waitFor({ timeout: 8000 });
  assert(true, 'a name still opens its card with Enter');
  await page.keyboard.press('Escape');

  // ─── Part 5: the Excel preview in Spanish ────────────────────────────
  console.log('\nPart 5');
  const xlsx = path.join(os.tmpdir(), `barrido2-${suffix}.xlsx`);
  const res = await api(`/api/projects/${project.id}/export.xlsx`, {
    method: 'POST',
    body: JSON.stringify({
      rows: [
        { id: 'BRDP-S1-00133', title: 'Another title', definition: 'Another definition', proposal: 'P', proposalStatus: 'Pending', ruleStatus: 'To Do', rule: '' },
        { id: 'BRDP-B2-BAD', title: 'T', definition: 'D', proposal: 'P', proposalStatus: 'Pending', ruleStatus: 'Draft', rule: '' },
      ],
    }),
  });
  fs.writeFileSync(xlsx, Buffer.from(await res.arrayBuffer()));
  await language().selectOption('es');
  await page.goto(`${BASE_URL}/projects/${project.id}/config`);
  await page.waitForSelector('input[type="file"][accept=".xlsx"]', { state: 'attached', timeout: 10000 });
  await page.locator('input[type="file"][accept=".xlsx"]').setInputFiles(xlsx);
  await page.waitForSelector('text=/Aplicar importación/', { timeout: 20000 });
  const body = await page.locator('body').innerText();
  assert(body.includes('Título y Definición sustituidos por el catálogo oficial'), 'list title: Título y Definición');
  assert(body.includes('Fila 2 (BRDP-S1-00133): el Título y la Definición serán los del catálogo, no los del fichero'), 'catalog override row in Spanish');
  assert(body.includes("Fila 3 (BRDP-B2-BAD): la columna Rule Status dice 'Draft' pero la columna Rule está vacía"), "rejected row: 'la columna Rule Status'");
  const start = body.indexOf('Importar BRDPs desde Excel');
  const section = body.slice(start, body.indexOf('Aplicar importación', start));
  assert(section.length > 200 && section.includes('Fila 2'), 'the preview section was read', section.slice(0, 200));
  // Field names in Spanish; English only as the name of an Excel column.
  const outsideColumns = section.replace(/columnas? (?:ID|Title|Definition|Proposal|Proposal Status|Rule Status|Rule)\b/g, '');
  assert(!/\b(Title|Definition|Proposal|Rule)\b/.test(outsideColumns), 'no English field name in the Spanish preview, except as "la columna …"', outsideColumns.slice(0, 600));
  await page.getByText('Importar BRDPs desde Excel').locator('xpath=..').screenshot({ path: path.join(SHOTS, 'part5-excel-preview-es.png') });
  fs.rmSync(xlsx, { force: true });

  console.log(`\nAll checks passed. Screenshots in ${SHOTS}`);
} finally {
  await browser.close();
  await api(`/api/projects/${project.id}?permanent=true`, { method: 'DELETE' });
}
