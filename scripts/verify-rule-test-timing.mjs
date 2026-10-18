// Live timing for "Test de reglas: que el motor reutilice las expresiones ya
// leídas (lentitud en DITA)": Navantia BRDP-EXT-00025 of a "DITA 1.3
// Xpath3.0" project (the dossier rule with sort() in the ditamap search),
// read from scripts/rule-test-fixtures/navantia-dita3-reconstructed.sch.
// Measures, in the browser, from the click to the moment the result is on
// screen (the engine runs synchronously on the main thread, so the wait is a
// requestAnimationFrame loop started right before the click):
//   - Verify on the untested Draft rule (analyzeRule in verifyWarning) until
//     the warning dialog shows; Cancel; again.
//   - "View passed test" on a Draft rule with a saved passed test (every
//     saved example is run again) until the panel shows; close; again.
//   - "Test rule" until the panel shows the description ("What the rule
//     checks", analyzeRule + describeRule); close; again. The examples come
//     from the simulator (mock-mistral-chat-server.mjs); this script times
//     only the opening.
// Prints a table (first and second click) and writes it as JSON to
// SHOTS_DIR/rule-test-timing.json (default: the system's temp directory).
// It only measures: run it on the code before and after a change and compare.
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the project it creates.
//
//     node scripts/verify-rule-test-timing.mjs [label]
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { shot } from './lib/shots.mjs';
import { readTextFile } from './lib/textFile.mjs';
import { keepAccountLanguage } from './lib/seeds.mjs';

const BASE_URL = 'http://localhost:5173';
const API = 'http://localhost:8000';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = 'admin@example.com';
// Gives the account back its language when the process exits (see lib/seeds.mjs).
keepAccountLanguage(ADMIN_EMAIL);
const ADMIN_PASSWORD = 'AdminTest123!';
const LABEL = process.argv[2] || 'run';

const SCH = readTextFile(new URL('./rule-test-fixtures/navantia-dita3-reconstructed.sch', import.meta.url));
const RULE = SCH.match(/<sch:pattern id="p-BRDP-EXT-00025"[\s\S]*?<\/sch:pattern>/)[0].replace(
  '<sch:pattern',
  '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"'
);
const MAP = '<map><title>Dosier</title><topicref href="fichas/ft-001.dita"/></map>';
const sheet = (items) => `<topic id="FT-001"><title>Ficha FT-001</title><body><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></body></topic>`;
const PASSED_TEST = {
  proposal: 'Una lista de una ficha del dosier tiene al menos dos elementos.',
  examples: [
    { label: 'Lista de dos elementos', expected: 'accept', xml: MAP, main_path: 'dossier.ditamap', files: [{ path: 'fichas/ft-001.dita', xml: sheet(['Uno', 'Dos']) }], result: 'accepted', matches: true },
    { label: 'Lista de un elemento', expected: 'reject', xml: MAP, main_path: 'dossier.ditamap', files: [{ path: 'fichas/ft-001.dita', xml: sheet(['Uno']) }], result: 'rejected', matches: true },
  ],
};

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Rule test timing ${suffix}`, standard: 'DITA 1.3 Xpath3.0' }) }).then((r) => r.json());
  const seed = async (identifier) => {
    const brdp = await api(`/api/projects/${project.id}/brdps`, {
      method: 'POST',
      body: JSON.stringify({ identifier, title: 'Listas de las fichas del dosier', definition: 'Decidir cuántos elementos lleva una lista.', proposal: PASSED_TEST.proposal, validation: 'Validated' }),
    }).then((x) => x.json());
    const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`, { method: 'PUT', body: JSON.stringify({ rule_xml: RULE, source: 'manual', status: 'pending_review' }) });
    if (!put.ok) throw new Error(`seeding failed: ${put.status} ${await put.text()}`);
    return brdp;
  };
  await seed('BRDP-EXT-00025');
  const passed = await seed('BRDP-EXT-90025');
  const rec = await api(`/api/projects/${project.id}/brdps/${passed.id}/approvals/SCH-DITA/test`, {
    method: 'POST',
    body: JSON.stringify({ result: 'passed', rule_hash: createHash('sha256').update(RULE, 'utf8').digest('hex'), passed_test: PASSED_TEST }),
  });
  if (!rec.ok) throw new Error(`recording the passed test failed: ${rec.status} ${await rec.text()}`);
  {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: 'POST' }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
  page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));
  // From right before the click until `waitFor` is on screen (rAF loop).
  const timeClick = (buttonText, waitFor, within = null) =>
    page.evaluate(
      async ({ buttonText, waitFor, within }) => {
        const root = within ? document.querySelector(within) : document;
        const button = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === buttonText || b.dataset.testid === buttonText);
        if (!button) throw new Error(`no button ${buttonText}`);
        const t0 = performance.now();
        button.click();
        await new Promise((resolve, reject) => {
          const deadline = t0 + 60000;
          const check = () => {
            if (document.querySelector(waitFor)) resolve();
            else if (performance.now() > deadline) reject(new Error(`timeout waiting for ${waitFor}`));
            else requestAnimationFrame(check);
          };
          check();
        });
        return Math.round(performance.now() - t0);
      },
      { buttonText, waitFor, within }
    );
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator('tbody tr', { hasText: identifier }).first().click();
    await page.waitForSelector('text=/BRDP Assistant|Asistente de BRDP/i', { timeout: 5000 });
    await page.getByTestId('rule-test-indicator').waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
  }
  const rows = [];
  try {
    await page.goto(BASE_URL);
    await page.fill('#login-email', ADMIN_EMAIL);
    await page.fill('#login-password', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('table', { timeout: 10000 });
    await page.locator('header select, nav select').first().selectOption('en');
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector('tbody tr', { timeout: 20000 });

    // Verify (untested Draft: analyzeRule before the dialog).
    await select('BRDP-EXT-00025');
    const verify = [];
    for (let i = 0; i < 2; i++) {
      verify.push(await timeClick('Verify', '[data-testid="verify-warning-dialog"]'));
      await page.getByTestId('verify-warning-dialog').getByRole('button', { name: 'Cancel' }).click();
      await page.waitForTimeout(500);
    }
    rows.push(['Verify', ...verify]);

    // Test rule (opening: analysis + description).
    const testRule = [];
    for (let i = 0; i < 2; i++) {
      testRule.push(await timeClick('Test rule', '[data-testid="rule-test-description"]'));
      await page.getByTestId('rule-test-verdict').or(page.getByTestId('rule-test-progress')).first().waitFor({ timeout: 40000 });
      await page.getByTestId('rule-test-verdict').waitFor({ timeout: 60000 }).catch(() => {});
      await page.getByTestId('rule-test-panel').getByRole('button', { name: 'Close' }).click();
      await page.waitForTimeout(500);
    }
    rows.push(['Test rule (open)', ...testRule]);

    // View passed test (every saved example run again).
    await select('BRDP-EXT-90025');
    const view = [];
    for (let i = 0; i < 2; i++) {
      view.push(await timeClick('saved-rule-test-open', '[data-testid="saved-rule-test-panel"]'));
      if (i === 0) await page.getByTestId('saved-rule-test-panel').screenshot({ path: shot(`rule-test-timing-saved-${LABEL}.png`) });
      await page.getByTestId('saved-rule-test-open').click();
      await page.waitForTimeout(500);
    }
    rows.push(['View passed test', ...view]);
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: 'DELETE' });
  }
  console.log(`\n${LABEL}: ms from click to result on screen`);
  console.log('| Action | 1st click | 2nd click |');
  console.log('|---|---|---|');
  for (const [name, a, b] of rows) console.log(`| ${name} | ${a} | ${b} |`);
  fs.writeFileSync(shot(`rule-test-timing-${LABEL}.json`), JSON.stringify(rows));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
