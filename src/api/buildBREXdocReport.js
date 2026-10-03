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

function statusBadgeHTML(validation) {
  const map = {
    'Validated': { bg: '#d1fae5', color: '#065f46', label: 'Validated' },
    'Refused':   { bg: '#fee2e2', color: '#991b1b', label: 'Refused' },
    'Pending':   { bg: '#fef3c7', color: '#92400e', label: 'Pending' },
  };
  const s = map[validation] || { bg: '#f3f4f6', color: '#6b7280', label: validation || '—' };
  return `<span style="background:${s.bg};color:${s.color};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${s.label}</span>`;
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 0; color: #111827; background: #fff; }
    .cover { background: #1e3a5f; color: white; padding: 60px 48px 40px; }
    .cover h1 { font-size: 28px; margin: 0 0 8px; font-weight: 700; }
    .cover h2 { font-size: 16px; margin: 0 0 32px; font-weight: 400; opacity: 0.8; }
    .cover-meta { display: flex; gap: 40px; flex-wrap: wrap; margin-top: 24px; }
    .cover-meta div { font-size: 13px; opacity: 0.85; }
    .cover-meta strong { display: block; font-size: 15px; opacity: 1; margin-top: 2px; }
    .section { padding: 32px 48px; }
    .section h2 { font-size: 18px; font-weight: 700; color: #1e3a5f; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 20px; }
    .stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
    .stat { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 24px; text-align: center; min-width: 100px; }
    .stat .num { font-size: 28px; font-weight: 700; color: #1e3a5f; }
    .stat .lbl { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
    .stat.green .num { color: #065f46; }
    .stat.red .num   { color: #991b1b; }
    .stat.amber .num { color: #92400e; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead tr { background: #1e3a5f; color: white; }
    thead th { padding: 10px 12px; text-align: left; font-weight: 600; font-size: 12px; letter-spacing: 0.04em; }
    tbody tr { border-bottom: 1px solid #e5e7eb; }
    tbody tr:nth-child(even) { background: #f9fafb; }
    td { padding: 10px 12px; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-validated { background: #d1fae5; color: #065f46; }
    .badge-refused   { background: #fee2e2; color: #991b1b; }
    .badge-pending   { background: #fef3c7; color: #92400e; }
    .badge-unknown   { background: #f3f4f6; color: #6b7280; }
    /* Rule Status replaces the old Comment column (docs request). Text
       colors are the EXACT hex values already established for Rule
       Status in BRDP Records/Projects (StatusCountsSummary.module.css --
       #2563eb Verified, #64748b Draft, #94a3b8 To Do), never a new
       palette; the light background tints are just this report's own
       existing badge-pill convention (light bg + the real status color as
       text, already used above for Proposal Status) applied to those same
       reused hues, not a fourth invented color scheme. */
    .badge-rule-verified { background: #dbeafe; color: #2563eb; }
    .badge-rule-draft    { background: #e2e8f0; color: #64748b; }
    .badge-rule-todo     { background: #f1f5f9; color: #94a3b8; }
    .pagination { display: flex; align-items: center; gap: 8px; padding: 16px 48px; justify-content: center; }
    .pagination button { padding: 6px 14px; border: 1px solid #e5e7eb; border-radius: 6px; background: white; cursor: pointer; font-size: 13px; color: #374151; }
    .pagination button:hover:not(:disabled) { background: #f3f4f6; }
    .pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pagination button.active { background: #1e3a5f; color: white; border-color: #1e3a5f; }
    .pagination-info { font-size: 13px; color: #6b7280; margin: 0 8px; }
    footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 16px 48px; font-size: 12px; color: #9ca3af; display: flex; justify-content: space-between; }
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
        <td style="font-family:monospace;font-size:12px;color:#2563eb;white-space:nowrap;">\${escapeHtml(b.id)}</td>
        <td style="font-weight:500;">\${escapeHtml(b.title)}</td>
        <td>\${escapeHtml(b.definition)}</td>
        <td>\${escapeHtml(b.proposal)}</td>
        <td style="text-align:center;"><span class="\${badgeClass(b.validation)}">\${escapeHtml(b.validation)}</span></td>
        <td style="text-align:center;"><span class="\${ruleBadgeClass(b.ruleStatus)}">\${escapeHtml(b.ruleStatus)}</span></td>
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
    `| \`${b.id || '—'}\` | ${escapeMarkdownCell(b.title)} | ${escapeMarkdownCell(b.definition)} | ${escapeMarkdownCell(b.proposal)} | ${b.validation || '—'} | ${escapeMarkdownCell(b.ruleStatus || 'To Do')} |`
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

| ID | Title | Definition | Proposal | Status | Rule Status |
|---|---|---|---|---|---|
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
