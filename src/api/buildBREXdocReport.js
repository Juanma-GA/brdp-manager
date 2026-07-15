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

  // Serialize all BRDP data as JSON for client-side pagination
  const brdpsJSON = JSON.stringify(brdps.map(b => ({
    id: b.id || '—',
    title: b.title || '—',
    definition: b.definition || '—',
    proposal: b.proposal || '—',
    validation: b.validation || '—',
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>BRDP Review Report — ${projectConfig.projectName || projectConfig.modelIdentCode || 'Project'}</title>
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
    <div>Project<strong>${projectConfig.projectName || '—'}</strong></div>
    <div>Model Ident Code<strong>${projectConfig.modelIdentCode || '—'}</strong></div>
    <div>Issue<strong>${projectConfig.issueNumber || '001'}-${projectConfig.inWork || '00'}</strong></div>
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
      </tr>
    </thead>
    <tbody id="brdp-tbody"></tbody>
  </table>
</div>

<div class="pagination no-print" id="pagination"></div>

<footer>
  <span>Generated by BRDP Manager</span>
  <span>${projectConfig.projectName || ''} — ${dateStr}</span>
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

  function renderPage(page) {
    currentPage = page;
    const start = (page - 1) * PAGE_SIZE;
    const slice = data.slice(start, start + PAGE_SIZE);
    const tbody = document.getElementById('brdp-tbody');
    tbody.innerHTML = slice.map(b => \`
      <tr>
        <td style="font-family:monospace;font-size:12px;color:#2563eb;white-space:nowrap;">\${b.id}</td>
        <td style="font-weight:500;">\${b.title}</td>
        <td>\${b.definition}</td>
        <td>\${b.proposal}</td>
        <td style="text-align:center;"><span class="\${badgeClass(b.validation)}">\${b.validation}</span></td>
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

export function buildMarkdown(brdps, projectConfig) {
  const today = new Date();
  const dateStr = formatDate(today);
  const total = brdps.length;
  const validated = brdps.filter(b => b.validation === 'Validated').length;
  const refused   = brdps.filter(b => b.validation === 'Refused').length;
  const pending   = brdps.filter(b => b.validation === 'Pending').length;

  const rows = brdps.map(b =>
    `| \`${b.id || '—'}\` | ${b.title || '—'} | ${(b.definition || '—').replace(/\n/g,' ')} | ${(b.proposal || '—').replace(/\n/g,' ')} | ${b.validation || '—'} |`
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

| ID | Title | Definition | Proposal | Status |
|---|---|---|---|---|
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
