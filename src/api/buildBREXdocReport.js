/**
 * buildBREXdocReport.js
 * Generates a BRDP review closure report in HTML or Markdown format.
 * No API calls — pure client-side generation.
 */

function formatDate(date) {
  return date.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'long', year: 'numeric'
  });
}

// BRDP free-text fields (title/definition/proposal, sourced from the
// official S1000D/DITA catalog prose) routinely contain a real element
// name written as "<table>"/"<copyright>"/"<applic>" etc. -- confirmed
// with a real Lufthansa report (BRDP-S1-00123's Title literally reads
// "...attribute applicRefId of the element <table>"). Not escaping that
// before an innerHTML assignment lets the browser parse it as markup: an
// unclosed "<table>" tag inside a <td> gets corrected by the browser by
// hoisting the rest of the row out of its own <tr>, which is exactly the
// "row floats outside the table" bug seen in that report. SOPTE and the
// Official Default 3.0.1 fixture happened not to contain any "<word>"
// substring, so they never triggered it -- that was luck in the data, not
// a difference in the code. Same class of issue as an unescaped-input
// injection bug even though every value here already passed through this
// app's own approval flow, not an external/untrusted source -- worth
// fixing with that rigor rather than treating it as cosmetic.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function buildHTML(brdps, projectConfig) {
  const today = new Date();
  const dateStr = formatDate(today);
  const total = brdps.length;
  const validated = brdps.filter(b => b.validation === 'Validated').length;
  const refused   = brdps.filter(b => b.validation === 'Refused').length;
  const pending   = brdps.filter(b => b.validation === 'Pending').length;

  // Serialize all BRDP data as JSON for client-side pagination. ruleStatus
  // replaces the old "Comment" column (docs request) -- the caller always
  // resolves it to one of "To Do"/"Draft"/"Verified" (never blank/missing:
  // "To Do" IS the correct, real status for a BRDP with no rule_approvals
  // row yet, not a placeholder for absent data), so the fallback below is
  // only a safety net for a caller that doesn't supply it at all.
  //
  // Escaping "<" as "<" here (not just in escapeHtml() below) guards
  // a second, related injection point: this JSON blob is glued directly
  // into the page's own <script> tag as source text, so a BRDP field
  // containing the literal substring "</script>" would otherwise close
  // that tag early and corrupt the whole generated report -- the same
  // "unescaped text breaks its surrounding markup" bug as the innerHTML
  // one above, just at the HTML-parse stage instead of render time.
  const brdpsJSON = JSON.stringify(brdps.map(b => ({
    id: b.id || '—',
    title: b.title || '—',
    definition: b.definition || '—',
    proposal: b.proposal || '—',
    validation: b.validation || '—',
    ruleStatus: b.ruleStatus || 'To Do',
    // "S1000D 4.1" when the identifier is only in another edition's
    // catalog; empty otherwise.
    catalogEdition: b.catalogEdition || '',
  }))).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>BRDP Review Report — ${escapeHtml(projectConfig.projectName || projectConfig.modelIdentCode || 'Project')}</title>
  <style>
    @media print {
      body { margin: 0; }
      .no-print { display: none; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; }
    }
    /* AACF 3, Part 2: the ATEXIS brand. This report is a standalone file
       (no app CSS, no font files), so the brand values are repeated here
       from src/index.css -- keep them in sync -- and the font is Inter if
       the reader has it, otherwise the system UI font. */
    :root {
      --primary: #2e74b5; --primary-dark: #245c90; --primary-tint: #eaf1f8;
      --bg: #ffffff; --surface: #f8fafc; --border: #e2e8f0;
      --text: #0f172a; --text-muted: #64748b; --text-strong-muted: #475569;
      --success-text: #065f46; --warning-text: #92400e; --error-text: #991b1b;
    }
    body { font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; margin: 0; padding: 0; color: var(--text); background: var(--bg); }
    .cover { background: var(--primary); color: var(--bg); padding: 60px 48px 40px; }
    .cover h1 { font-size: 28px; margin: 0 0 8px; font-weight: 700; }
    .cover h2 { font-size: 16px; margin: 0 0 32px; font-weight: 400; }
    .cover-meta { display: flex; gap: 40px; flex-wrap: wrap; margin-top: 24px; }
    .cover-meta div { font-size: 13px; }
    .cover-meta strong { display: block; font-size: 15px; margin-top: 2px; }
    .section { padding: 32px 48px; }
    .section h2 { font-size: 18px; font-weight: 700; color: var(--primary-dark); border-bottom: 2px solid var(--border); padding-bottom: 8px; margin-bottom: 20px; }
    .stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
    .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px 24px; text-align: center; min-width: 100px; }
    .stat .num { font-size: 28px; font-weight: 700; color: var(--primary-dark); }
    .stat .lbl { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
    .stat.green .num { color: var(--success-text); }
    .stat.red .num   { color: var(--error-text); }
    .stat.amber .num { color: var(--warning-text); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead tr { background: var(--primary); color: var(--bg); }
    thead th { padding: 10px 12px; text-align: left; font-weight: 600; font-size: 12px; letter-spacing: 0.04em; }
    tbody tr { border-bottom: 1px solid var(--border); }
    tbody tr:nth-child(even) { background: var(--surface); }
    td { padding: 10px 12px; }
    .id-cell { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--primary-dark); white-space: nowrap; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-validated { background: #d1fae5; color: var(--success-text); }
    .badge-refused   { background: #fee2e2; color: var(--error-text); }
    .badge-pending   { background: #fef3c7; color: var(--warning-text); }
    .badge-unknown   { background: #f1f5f9; color: var(--text-muted); }
    /* Rule Status: the same three tones as BRDP Records (Verified in the
       primary, Draft and To Do in two slates), each with AA contrast on
       its pill. */
    .badge-rule-verified { background: var(--primary-tint); color: var(--primary-dark); }
    .badge-rule-draft    { background: var(--border); color: var(--text-strong-muted); }
    .badge-rule-todo     { background: #f1f5f9; color: var(--text-muted); }
    .pagination { display: flex; align-items: center; gap: 8px; padding: 16px 48px; justify-content: center; }
    .pagination button { padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); cursor: pointer; font-size: 13px; color: var(--text); font-family: inherit; }
    .pagination button:hover:not(:disabled) { background: var(--surface); }
    .pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pagination button.active { background: var(--primary); color: var(--bg); border-color: var(--primary); }
    .pagination-info { font-size: 13px; color: var(--text-muted); margin: 0 8px; }
    footer { background: var(--surface); border-top: 1px solid var(--border); padding: 16px 48px; font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between; }
  </style>
</head>
<body>

<div class="cover">
  <h1>BRDP Review Closure Report</h1>
  <h2>Business Rules Decision Points — Review Summary</h2>
  <div class="cover-meta">
    <div>Project<strong>${escapeHtml(projectConfig.projectName || '—')}</strong></div>
    <div>Model Ident Code<strong>${escapeHtml(projectConfig.modelIdentCode || '—')}</strong></div>
    <div>Issue<strong>${escapeHtml(projectConfig.issueNumber || '001')}-${escapeHtml(projectConfig.inWork || '00')}</strong></div>
    <div>Date<strong>${dateStr}</strong></div>
    <div>Standard<strong>S1000D Issue 4.2</strong></div>
  </div>
</div>

<div class="section">
  <h2>Summary</h2>
  <div class="stats">
    <div class="stat"><div class="num">${total}</div><div class="lbl">Total BRDPs</div></div>
    <div class="stat green"><div class="num">${validated}</div><div class="lbl">Validated</div></div>
    <div class="stat red"><div class="num">${refused}</div><div class="lbl">Refused</div></div>
    <div class="stat amber"><div class="num">${pending}</div><div class="lbl">Pending</div></div>
  </div>
</div>

<div class="section">
  <h2>BRDP Detail</h2>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Title</th>
        <th>Definition</th>
        <th>Proposal</th>
        <th>Status</th>
        <th>Rule Status</th>
        <th>Catalog Edition</th>
      </tr>
    </thead>
    <tbody id="brdp-tbody"></tbody>
  </table>
</div>

<div class="pagination no-print" id="pagination"></div>

<footer>
  <span>Generated by BRDP Manager</span>
  <span>${escapeHtml(projectConfig.projectName || '')} — ${dateStr}</span>
</footer>

<script>
  const PAGE_SIZE = 50;
  const data = ${brdpsJSON};
  let currentPage = 1;
  const totalPages = Math.ceil(data.length / PAGE_SIZE);

  function badgeClass(v) {
    if (v === 'Validated') return 'badge badge-validated';
    if (v === 'Refused')   return 'badge badge-refused';
    if (v === 'Pending')   return 'badge badge-pending';
    return 'badge badge-unknown';
  }

  function ruleBadgeClass(v) {
    if (v === 'Verified') return 'badge badge-rule-verified';
    if (v === 'Draft')    return 'badge badge-rule-draft';
    return 'badge badge-rule-todo';
  }

  // This is the actual injection point (docs request, confirmed with a
  // real report): BRDP free text can legitimately contain "<word>" (a
  // real S1000D element name mentioned in prose, e.g. "...the element
  // <table>"), and tbody.innerHTML below inserts it raw -- without
  // escaping, the browser parses that as a real (unclosed) <table> tag
  // and "fixes" the broken markup by hoisting the rest of that row out of
  // its own <tr>, which is the row-floats-outside-the-table bug. Same
  // rigor as escaping any untrusted-shaped input before an innerHTML
  // write, even though every value here already passed through this
  // app's own approval flow rather than an external source.
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderPage(page) {
    currentPage = page;
    const start = (page - 1) * PAGE_SIZE;
    const slice = data.slice(start, start + PAGE_SIZE);
    const tbody = document.getElementById('brdp-tbody');
    tbody.innerHTML = slice.map(b => \`
      <tr>
        <td class="id-cell">\${escapeHtml(b.id)}</td>
        <td style="font-weight:500;">\${escapeHtml(b.title)}</td>
        <td>\${escapeHtml(b.definition)}</td>
        <td>\${escapeHtml(b.proposal)}</td>
        <td style="text-align:center;"><span class="\${badgeClass(b.validation)}">\${escapeHtml(b.validation)}</span></td>
        <td style="text-align:center;"><span class="\${ruleBadgeClass(b.ruleStatus)}">\${escapeHtml(b.ruleStatus)}</span></td>
        <td style="white-space:nowrap;">\${escapeHtml(b.catalogEdition)}</td>
      </tr>\`).join('');
    renderPagination();
    window.scrollTo({ top: document.querySelector('.section:last-of-type').offsetTop - 20, behavior: 'smooth' });
  }

  function renderPagination() {
    const container = document.getElementById('pagination');
    const start = (currentPage - 1) * PAGE_SIZE + 1;
    const end = Math.min(currentPage * PAGE_SIZE, data.length);
    let html = \`<button onclick="renderPage(\${currentPage - 1})" \${currentPage === 1 ? 'disabled' : ''}>← Prev</button>\`;
    html += \`<span class="pagination-info">Showing \${start}–\${end} of \${data.length} BRDPs — Page \${currentPage} of \${totalPages}</span>\`;
    // Page number buttons (show max 7 around current)
    const range = [];
    for (let i = Math.max(1, currentPage - 3); i <= Math.min(totalPages, currentPage + 3); i++) range.push(i);
    if (range[0] > 1) html += '<button disabled>…</button>';
    range.forEach(p => {
      html += \`<button onclick="renderPage(\${p})" class="\${p === currentPage ? 'active' : ''}">\${p}</button>\`;
    });
    if (range[range.length - 1] < totalPages) html += '<button disabled>…</button>';
    html += \`<button onclick="renderPage(\${currentPage + 1})" \${currentPage === totalPages ? 'disabled' : ''}>Next →</button>\`;
    container.innerHTML = html;
  }

  renderPage(1);
</script>

</body>
</html>`;
}

// Markdown's own injection risk (docs request: review this alongside the
// HTML one, even though it's lower-severity since there's no script
// execution) -- a "|" in free text (title/definition/proposal/rule
// status) is a real GFM table column delimiter, so an unescaped one
// shifts every following cell on that row into the wrong column instead
// of corrupting the page like the HTML case, but it's the same root
// cause: raw text glued into a format where that character is special.
// Newlines are collapsed to spaces for the same reason they already were
// (a literal newline breaks a GFM row the same way).
function escapeMarkdownCell(value) {
  return String(value ?? '—').replace(/\n/g, ' ').replace(/\|/g, '\\|');
}

export function buildMarkdown(brdps, projectConfig) {
  const today = new Date();
  const dateStr = formatDate(today);
  const total = brdps.length;
  const validated = brdps.filter(b => b.validation === 'Validated').length;
  const refused   = brdps.filter(b => b.validation === 'Refused').length;
  const pending   = brdps.filter(b => b.validation === 'Pending').length;

  const rows = brdps.map(b =>
    `| \`${b.id || '—'}\` | ${escapeMarkdownCell(b.title)} | ${escapeMarkdownCell(b.definition)} | ${escapeMarkdownCell(b.proposal)} | ${b.validation || '—'} | ${escapeMarkdownCell(b.ruleStatus || 'To Do')} | ${escapeMarkdownCell(b.catalogEdition || '')} |`
  ).join('\n');

  return `# BRDP Review Closure Report

**Project:** ${projectConfig.projectName || '—'}
**Model Ident Code:** ${projectConfig.modelIdentCode || '—'}
**Issue:** ${projectConfig.issueNumber || '001'}-${projectConfig.inWork || '00'}
**Date:** ${dateStr}
**Standard:** S1000D Issue 4.2

---

## Summary

| | Count |
|---|---|
| Total BRDPs | ${total} |
| Validated | ${validated} |
| Refused | ${refused} |
| Pending | ${pending} |

---

## BRDP Detail

| ID | Title | Definition | Proposal | Status | Rule Status | Catalog Edition |
|---|---|---|---|---|---|---|
${rows}

---

*Generated by BRDP Manager — ${dateStr}*
`;
}

export function downloadReport(brdps, projectConfig, format) {
  const today = new Date().toISOString().slice(0, 10);
  const baseName = `BRDP-Report_${projectConfig.modelIdentCode || 'Project'}_${today}`;

  let content, filename, mimeType;

  if (format === 'html') {
    content  = buildHTML(brdps, projectConfig);
    filename = baseName + '.html';
    mimeType = 'text/html';
  } else {
    content  = buildMarkdown(brdps, projectConfig);
    filename = baseName + '.md';
    mimeType = 'text/markdown';
  }

  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
