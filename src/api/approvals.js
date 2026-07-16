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

// Creates or overwrites a rule approval. Defaults to a pending_review
// candidate -- see approveApproval() for the pending_review -> approved
// transition. Pass status='approved' only for a manually written/reviewed
// rule (DetailPanel's manual edit mode), where there's nothing left to
// re-review after the human wrote it themselves.
export async function proposeApproval(brdpId, format, ruleXml, source, status) {
  const res = await fetch(`${BASE}/api/approvals/${encodeURIComponent(brdpId)}/${encodeURIComponent(format)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ruleXml, source, status }),
  });
  if (!res.ok) throw new Error('Failed to save rule approval');
  return res.json();
}

// Transitions an existing pending_review row to approved. Throws if there
// is no pending_review row for this BRDP/format (404).
export async function approveApproval(brdpId, format) {
  const res = await fetch(`${BASE}/api/approvals/${encodeURIComponent(brdpId)}/${encodeURIComponent(format)}/approve`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to approve rule approval');
  return res.json();
}

export async function deleteApproval(brdpId, format) {
  const res = await fetch(`${BASE}/api/approvals/${encodeURIComponent(brdpId)}/${encodeURIComponent(format)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete rule approval');
  return res.json();
}
