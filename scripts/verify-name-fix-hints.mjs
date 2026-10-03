// Verification for "Sugerencias para erratas y nombres de otro estándar":
// near names ("Did you mean") and names of another standard for marked
// names that do not exist, against the real app (Vite + uvicorn + Postgres).
// No LLM involved (the check is deterministic). Cleans up its projects.
//   - 4.2, Definition with <emphasys>: red line + "did you mean <emphasis>?"
//     line, chip under the field, one click fixes it and it persists;
//   - the other standards' vocabularies are NOT fetched on page open, only
//     once a name needs them;
//   - 3.0.1 with <levelledPara>: "exists in S1000D 4.1 and 4.2";
//   - DITA with <para>: "exists in S1000D 3.0.1, 4.1 and 4.2";
//   - S1-00065 title: no <source> chip;
//   - manual rule editor with //emphasys: the line, no chip;
//   - EN and ES.
// Run: node scripts/verify-name-fix-hints.mjs
import { chromium } from 'playwright-core';

const BASE_URL = 'http://localhost:5173';
const API = 'http://localhost:8000';
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || 'AdminTest123!';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('OK:', msg);
}

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (HTTP ${res.status})`);
  return (await res.json()).access_token;
}
const json = (r) => r.json();

async function login(page, lang) {
  await page.goto(BASE_URL);
  await page.fill('#login-email', ADMIN_EMAIL);
  await page.fill('#login-password', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('table', { timeout: 10000 });
  await page.locator('header select, nav select').first().selectOption(lang);
  await page.waitForTimeout(300);
}

async function openRecords(page, projectId) {
  await page.goto(`${BASE_URL}/projects/${projectId}/records`);
  await page.waitForSelector('tbody tr', { timeout: 20000 });
}
async function select(page, identifier) {
  await page.locator('tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${identifier}`) }) }).first().click();
  await page.waitForTimeout(500);
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const suffix = Math.random().toString(36).slice(2, 8);
  const created = [];
  const makeProject = async (name, standard) => {
    const p = await fetch(`${API}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name, standard }) }).then(json);
    created.push(p.id);
    return p;
  };
  const makeBrdp = (projectId, body) =>
    fetch(`${API}/api/projects/${projectId}/brdps`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ definition: '', proposal: '', validation: 'Pending', ...body }),
    }).then(json);

  const p42 = await makeProject(`Name Hints 4.2 ${suffix}`, 'S1000D 4.2');
  await makeBrdp(p42.id, { identifier: 'BRDP-NH-CLEAN', title: 'Use of the <table> element' });
  await makeBrdp(p42.id, { identifier: 'BRDP-NH-TYPO', title: 'Emphasis', definition: 'Do not use <emphasys> in warnings.' });
  await makeBrdp(p42.id, { identifier: 'BRDP-NH-CAPS', title: 'Use @emphasistype' });
  await makeBrdp(p42.id, { identifier: 'BRDP-S1-00065', title: 'Use of the element <copyright> and source of copyright information' });
  const ruleBrdp = await makeBrdp(p42.id, { identifier: 'BRDP-NH-RULE', title: 'Rule with a typo' });
  await fetch(`${API}/api/projects/${p42.id}/brdps/${ruleBrdp.id}/approvals/BREX-4.2`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({
      rule_xml: '<structureObjectRule id="BRDP-NH-RULE"><objectPath allowedObjectFlag="0">//para</objectPath><objectUse>x</objectUse></structureObjectRule>',
      source: 'manual',
    }),
  }).then((r) => {
    if (!r.ok) throw new Error(`rule PUT ${r.status}`);
  });
  const p301 = await makeProject(`Name Hints 3.0.1 ${suffix}`, 'S1000D 3.0.1');
  await makeBrdp(p301.id, { identifier: 'BRDP-NH-301', title: 'Levels of <levelledPara>' });
  const pDita = await makeProject(`Name Hints DITA ${suffix}`, 'DITA 1.3 Xpath2.0');
  await makeBrdp(pDita.id, { identifier: 'BRDP-NH-DITA', title: 'Use of <para> in topics' });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  try {
    // ── 1. 4.2: no other vocabularies on open; typo + chip + fix ────────
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      const vocabRequests = [];
      page.on('request', (r) => {
        const m = r.url().match(/schema-vocabulary-([\w-]+)\.json/);
        if (m) vocabRequests.push(m[1]);
      });
      await login(page, 'en');
      await openRecords(page, p42.id);
      await select(page, 'BRDP-NH-CLEAN');
      await page.waitForTimeout(800);
      assert(vocabRequests.every((v) => v === '4-2'), `only the project's vocabulary is fetched on open (got: ${[...new Set(vocabRequests)]})`);

      await select(page, 'BRDP-NH-TYPO');
      const line = page.getByTestId('name-did-you-mean');
      await line.waitFor({ timeout: 5000 });
      assert((await line.textContent()).includes('<emphasys> does not exist; did you mean <emphasis>?'), 'did-you-mean line under the red notice');
      assert((await page.locator('text=/mentions names not found/').count()) === 1, 'the red "not found" line stays');
      await page.waitForTimeout(500);
      assert(new Set(vocabRequests).size > 1, 'the other vocabularies are fetched once a name needs them');
      const chip = page.getByTestId('name-fix-suggestion').filter({ hasText: 'Did you mean <emphasis>?' });
      assert((await chip.count()) === 1, 'chip "Did you mean <emphasis>?" under the Definition');
      await page.screenshot({ path: '/tmp/name-fix-hints-typo.png', fullPage: true });
      await chip.click();
      await page.waitForTimeout(800);
      const definition = page.locator('label:text-is("Definition") + textarea');
      assert((await definition.inputValue()) === 'Do not use <emphasis> in warnings.', 'one click fixes the Definition');
      assert((await page.getByTestId('name-did-you-mean').count()) === 0, 'the hint line disappears after the fix');
      assert((await page.locator('text=/mentions names not found/').count()) === 0, 'and the red line too');
      await page.reload();
      await page.waitForSelector('tbody tr', { timeout: 20000 });
      await select(page, 'BRDP-NH-TYPO');
      assert((await page.locator('label:text-is("Definition") + textarea').inputValue()) === 'Do not use <emphasis> in warnings.', 'the fix is saved');

      await select(page, 'BRDP-NH-CAPS');
      await page.getByTestId('name-did-you-mean').waitFor({ timeout: 5000 });
      assert((await page.getByTestId('name-did-you-mean').textContent()).includes('did you mean @emphasisType?'), '@emphasistype -> @emphasisType');
      await page.getByTestId('name-fix-suggestion').filter({ hasText: '@emphasisType' }).click();
      await page.waitForTimeout(800);
      assert((await page.locator('label:text-is("Title") + input').inputValue()) === 'Use @emphasisType', 'attribute fixed in the Title');

      await select(page, 'BRDP-S1-00065');
      await page.waitForTimeout(500);
      assert((await page.getByRole('button', { name: /Did you mean <source>/ }).count()) === 0, 'S1-00065 title: no <source> chip');
      assert((await page.getByRole('button', { name: /Did you mean/ }).count()) === 0, 'S1-00065 title: no chip at all');

      await select(page, 'BRDP-NH-RULE');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.locator('textarea[spellcheck="false"]').first();
      await editor.fill(
        '<structureObjectRule id="BRDP-NH-RULE"><objectPath allowedObjectFlag="0">//para/emphasys</objectPath><objectUse>x</objectUse></structureObjectRule>'
      );
      await page.getByTestId('name-did-you-mean').waitFor({ timeout: 5000 });
      assert((await page.getByTestId('name-did-you-mean').textContent()).includes('<emphasys> does not exist; did you mean <emphasis>?'), 'rule editor: the hint line');
      const ruleChips = await page.locator('[class*="ruleEditor"] [data-testid="name-fix-suggestion"]').count();
      assert(ruleChips === 0, 'rule editor: no one-click fix');
      assert(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), 'rule editor: Save not blocked by the hint');
      await page.screenshot({ path: '/tmp/name-fix-hints-rule-editor.png', fullPage: true });
      await page.close();
    }

    // ── 2. 3.0.1 with <levelledPara> (EN and ES) ────────────────────────
    for (const lang of ['en', 'es']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page, lang);
      await openRecords(page, p301.id);
      await select(page, 'BRDP-NH-301');
      const line = page.getByTestId('name-other-standard');
      await line.waitFor({ timeout: 5000 });
      const expected =
        lang === 'en'
          ? '<levelledPara> does not exist in S1000D 3.0.1; it exists in S1000D 4.1 and 4.2.'
          : '<levelledPara> no existe en S1000D 3.0.1; existe en S1000D 4.1 y 4.2.';
      assert((await line.textContent()).includes(expected), `3.0.1 (${lang}): ${expected}`);
      assert((await page.getByTestId('name-fix-suggestion').count()) === 0, `3.0.1 (${lang}): no chip, no equivalence proposed`);
      if (lang === 'es') await page.screenshot({ path: '/tmp/name-fix-hints-301-es.png', fullPage: true });
      await page.close();
    }

    // ── 3. DITA with <para> (ES and EN) ─────────────────────────────────
    for (const lang of ['es', 'en']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page, lang);
      await openRecords(page, pDita.id);
      await select(page, 'BRDP-NH-DITA');
      const line = page.getByTestId('name-other-standard');
      await line.waitFor({ timeout: 5000 });
      const expected =
        lang === 'es'
          ? '<para> no existe en DITA 1.3; existe en S1000D 3.0.1, 4.1 y 4.2.'
          : '<para> does not exist in DITA 1.3; it exists in S1000D 3.0.1, 4.1 and 4.2.';
      assert((await line.textContent()).includes(expected), `DITA (${lang}): ${expected}`);
      assert((await page.getByTestId('name-did-you-mean').count()) === 0, `DITA (${lang}): no did-you-mean (param/part)`);
      if (lang === 'es') {
        assert((await page.getByTestId('name-fix-suggestion').count()) === 0, 'DITA: no chip');
        await page.screenshot({ path: '/tmp/name-fix-hints-dita-es.png', fullPage: true });
      }
      await page.close();
    }

    // ── 4. Did you mean in Spanish ─────────────────────────────────────
    {
      await makeBrdp(p42.id, { identifier: 'BRDP-NH-ES', title: 'No usar <levelledpara>' });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page, 'es');
      await openRecords(page, p42.id);
      await select(page, 'BRDP-NH-ES');
      await page.getByTestId('name-did-you-mean').waitFor({ timeout: 5000 });
      assert(
        (await page.getByTestId('name-did-you-mean').textContent()).includes('<levelledpara> no existe; ¿quisiste decir <levelledPara>?'),
        'ES did-you-mean line'
      );
      assert((await page.getByRole('button', { name: '¿Quisiste decir <levelledPara>?' }).count()) === 1, 'ES chip');
      await page.close();
    }
  } finally {
    await browser.close();
    for (const id of created) await fetch(`${API}/api/projects/${id}`, { method: 'DELETE', headers: auth });
  }
  console.log('\nAll checks passed.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
