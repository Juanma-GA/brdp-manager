/**
 * Rule approvals — per (BRDP, format) frozen deterministic rule.
 * REST client mirroring src/services/api.js's notes functions.
 */

const BASE = '';

export async function getApproval(brdpId, format) {
  const res = await fetch(`${BASE}/api/approvals/${encodeURIComponent(brdpId)}/${encodeURIComponent(format)}`);
  if (!res.ok) return null;
  return res.json();
}

// Batch fetch: every frozen approval for a given format in one request,
// instead of one GET per BRDP. Returns [] on a non-ok response.
export async function getApprovalsForFormat(format) {
  const res = await fetch(`${BASE}/api/approvals/format/${encodeURIComponent(format)}`);
  if (!res.ok) return [];
  return res.json();
}

export async function setApproval(brdpId, format, ruleXml, source) {
  const res = await fetch(`${BASE}/api/approvals/${encodeURIComponent(brdpId)}/${encodeURIComponent(format)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ruleXml, source }),
  });
  if (!res.ok) throw new Error('Failed to save rule approval');
  return res.json();
}

export async function deleteApproval(brdpId, format) {
  const res = await fetch(`${BASE}/api/approvals/${encodeURIComponent(brdpId)}/${encodeURIComponent(format)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete rule approval');
  return res.json();
}
