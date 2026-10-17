/**
 * What the user typed in a BRDP's text fields and the server has not saved
 * yet (AACF 1, Part 1): Title, Definition, Proposal and the refusal reason.
 *
 * The page keeps the SAVED BRDP (what the server answered) apart from what
 * is being typed: the table and everything else read the saved value; a
 * field reads its entry here when it has one. An entry is
 *
 *   { brdpId, field, value, status, sentValue, error, retryable, rejectedValue }
 *
 * status "editing" (typed, not sent yet), "saving" (sent: `sentValue`) or
 * "failed" (the server refused it or never answered: `error` is the
 * sentence to show, `rejectedValue` what was refused). A failed entry keeps
 * the text; it is removed only by a save that succeeds or by "Discard". Its
 * Retry works when trying again can (`retryable`: no network, a server
 * error) or once the text changed (a text too long, refused by validation,
 * cannot be saved until it is shortened).
 *
 * Pure: every function returns a new Map (React state), so it runs in Node
 * tests. The page also remembers the entries per project in memory
 * (rememberUnsaved/recallUnsaved), so an expired session -- the login page
 * replaces Records, and comes back to it -- never loses what was typed.
 * Never in localStorage (HR1): a reload asks the browser's own "leave the
 * page?" instead.
 */

export const SAVED_TEXT_FIELDS = ['title', 'definition', 'proposal', 'comments'];

export function fieldKey(brdpId, field) {
  return `${brdpId}:${field}`;
}

/** The text the field shows: its entry's, or the saved one. */
export function displayedValue(state, brdp, field) {
  const entry = state.get(fieldKey(brdp.id, field));
  return entry ? entry.value : (brdp[field] ?? '');
}

/** A keystroke. A failed entry stays failed (still not saved) with its error. */
export function editField(state, brdpId, field, value) {
  const key = fieldKey(brdpId, field);
  const next = new Map(state);
  const entry = state.get(key);
  next.set(key, entry ? { ...entry, value } : { brdpId, field, value, status: 'editing', sentValue: null, error: null, retryable: true, rejectedValue: null });
  return next;
}

/** The text is being sent. */
export function startSave(state, brdpId, field, value) {
  const key = fieldKey(brdpId, field);
  const entry = state.get(key) || { brdpId, field, error: null, retryable: true, rejectedValue: null };
  const next = new Map(state);
  next.set(key, { ...entry, value: entry.value ?? value, status: 'saving', sentValue: value });
  return next;
}

// Only the answer to the LATEST send of a field counts: an older one that
// comes back later must not change the field's state.
function isLatest(entry, sentValue) {
  return !!entry && entry.status === 'saving' && entry.sentValue === sentValue;
}

/** The server saved `sentValue`. The entry goes away, unless more was typed meanwhile. */
export function saveSucceeded(state, brdpId, field, sentValue) {
  const key = fieldKey(brdpId, field);
  const entry = state.get(key);
  if (!isLatest(entry, sentValue)) return state;
  const next = new Map(state);
  if (entry.value === sentValue) next.delete(key);
  else next.set(key, { ...entry, status: 'editing', sentValue: null, error: null, rejectedValue: null });
  return next;
}

/** The server refused `sentValue` (or never answered): the text stays, marked unsaved. */
export function saveFailed(state, brdpId, field, sentValue, { message, retryable }) {
  const key = fieldKey(brdpId, field);
  const entry = state.get(key);
  if (!isLatest(entry, sentValue)) return state;
  const next = new Map(state);
  next.set(key, { ...entry, status: 'failed', sentValue: null, error: message, retryable: !!retryable, rejectedValue: sentValue });
  return next;
}

/** "Discard change": back to the saved value. */
export function discardField(state, brdpId, field) {
  const key = fieldKey(brdpId, field);
  if (!state.has(key)) return state;
  const next = new Map(state);
  next.delete(key);
  return next;
}

/** Every entry of one BRDP removed (it was deleted, or the user chose to leave it). */
export function discardBrdp(state, brdpId, { onlyFailed = false } = {}) {
  let changed = false;
  const next = new Map(state);
  for (const [key, entry] of state) {
    if (entry.brdpId === brdpId && (!onlyFailed || entry.status === 'failed')) {
      next.delete(key);
      changed = true;
    }
  }
  return changed ? next : state;
}

/**
 * What leaving the field (blur) does: "skip" (nothing to send: no entry,
 * the same text is already being sent, or a refused text unchanged),
 * "discard" (the text is the saved one again -- unless another text is on
 * its way, which this one must then replace) or "save".
 */
export function blurAction(state, brdp, field) {
  const entry = state.get(fieldKey(brdp.id, field));
  if (!entry) return 'skip';
  if (entry.status === 'saving') return entry.sentValue === entry.value ? 'skip' : 'save';
  if (entry.value === (brdp[field] ?? '')) return 'discard';
  if (entry.status === 'failed' && entry.value === entry.rejectedValue) return 'skip';
  return 'save';
}

/** Whether "Retry" can work for this entry now. */
export function canRetry(entry) {
  return !!entry && entry.status === 'failed' && (entry.retryable || entry.value !== entry.rejectedValue);
}

/** The entries that failed (of one BRDP, or all). */
export function failedEntries(state, brdpId = null) {
  return [...state.values()].filter((e) => e.status === 'failed' && (brdpId === null || e.brdpId === brdpId));
}

/** Anything not saved yet: what the browser's "leave the page?" protects. */
export function hasUnsaved(state) {
  return state.size > 0;
}

/**
 * After the BRDPs are loaded again (the page came back after a session
 * expired): an entry whose text is now the saved one is gone; any other is
 * kept as failed -- its save either failed or was never confirmed.
 */
export function reconcileWithSaved(state, brdps, notConfirmedMessage) {
  const byId = new Map(brdps.map((b) => [b.id, b]));
  const next = new Map();
  for (const [key, entry] of state) {
    const brdp = byId.get(entry.brdpId);
    if (!brdp) continue;
    if (entry.value === (brdp[entry.field] ?? '')) continue;
    next.set(
      key,
      entry.status === 'failed'
        ? entry
        : { ...entry, status: 'failed', sentValue: null, error: notConfirmedMessage, retryable: true, rejectedValue: entry.value }
    );
  }
  return next;
}

// ── In-memory, per project (never localStorage, HR1) ─────────────────────

const remembered = new Map();

export function rememberUnsaved(projectId, state) {
  if (state.size > 0) remembered.set(projectId, state);
  else remembered.delete(projectId);
}

export function recallUnsaved(projectId) {
  return remembered.get(projectId) || new Map();
}

// ── Optimistic list changes (delete a BRDP) ───────────────────────────────

/** The list without one row, and where it was (to put it back). */
export function removeRow(list, id) {
  const index = list.findIndex((b) => b.id === id);
  if (index < 0) return { list, row: null, index: -1 };
  return { list: [...list.slice(0, index), ...list.slice(index + 1)], row: list[index], index };
}

/** The row back at its place, unless the list already has it again. */
export function restoreRow(list, row, index) {
  if (!row || list.some((b) => b.id === row.id)) return list;
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), row, ...list.slice(at)];
}
