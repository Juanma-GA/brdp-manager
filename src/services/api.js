/**
 * API service layer — replaces direct localStorage access with REST calls to Express server.
 * All functions return Promises.
 */

const BASE = '';

// ─── BRDPs ────────────────────────────────────────────────────────────────────

export async function fetchBRDPs() {
  const res = await fetch(`${BASE}/api/brdps`);
  if (!res.ok) throw new Error('Failed to fetch BRDPs');
  return res.json();
}

export async function createBRDP(brdp) {
  const res = await fetch(`${BASE}/api/brdps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brdp),
  });
  if (!res.ok) throw new Error('Failed to create BRDP');
  return res.json();
}

export async function updateBRDPApi(id, brdp) {
  const res = await fetch(`${BASE}/api/brdps/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brdp),
  });
  if (!res.ok) throw new Error('Failed to update BRDP');
  return res.json();
}

export async function deleteBRDP(id) {
  const res = await fetch(`${BASE}/api/brdps/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete BRDP');
  return res.json();
}

export async function deleteAllBRDPs() {
  const res = await fetch(`${BASE}/api/brdps`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete all BRDPs');
  return res.json();
}

export async function saveBRDPs(brdps) {
  // Save full array: delete all then insert each
  await deleteAllBRDPs();
  for (const brdp of brdps) {
    await createBRDP(brdp);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function fetchConfig() {
  const res = await fetch(`${BASE}/api/config`);
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function saveConfig(config) {
  const res = await fetch(`${BASE}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error('Failed to save config');
  return res.json();
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function fetchSettings() {
  const res = await fetch(`${BASE}/api/settings`);
  if (!res.ok) throw new Error('Failed to fetch settings');
  return res.json();
}

export async function saveSettings(settings) {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error('Failed to save settings');
  return res.json();
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function fetchNote(brdpId) {
  const res = await fetch(`${BASE}/api/notes/${brdpId}`);
  if (!res.ok) return '';
  const data = await res.json();
  return data.text || '';
}

export async function saveNote(brdpId, text) {
  const res = await fetch(`${BASE}/api/notes/${brdpId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error('Failed to save note');
  return res.json();
}
