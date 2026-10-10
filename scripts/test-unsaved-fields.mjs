// AACF 1, Parts 1 and 3: the pure logic behind "nothing typed is lost" in
// Records (src/utils/unsavedFields.js) and the sanitized error sentences
// (src/services/apiErrors.js). Plain Node, the real modules and the real
// i18n.
// Run: node scripts/test-unsaved-fields.mjs
import i18n from '../src/i18n/index.js';
import {
  ApiError,
  describeErrorDetail,
  errorMessage,
  isRetryable,
  networkError,
  validationItemText,
} from '../src/services/apiErrors.js';
import {
  blurAction,
  canRetry,
  discardBrdp,
  discardField,
  displayedValue,
  editField,
  failedEntries,
  fieldKey,
  hasUnsaved,
  recallUnsaved,
  reconcileWithSaved,
  rememberUnsaved,
  removeRow,
  restoreRow,
  saveFailed,
  saveSucceeded,
  startSave,
} from '../src/utils/unsavedFields.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');

// ── unsavedFields ─────────────────────────────────────────────────────────
const brdp = { id: 'b1', title: 'Saved title', definition: '', proposal: 'P', comments: '' };
let s = new Map();
check('nothing typed: the saved value', displayedValue(s, brdp, 'title') === 'Saved title');
check('nothing typed: blur does nothing', blurAction(s, brdp, 'title') === 'skip');
check('nothing typed: nothing unsaved', !hasUnsaved(s));

s = editField(s, 'b1', 'title', 'New title');
check('typed: the field shows it', displayedValue(s, brdp, 'title') === 'New title');
check('typed: the BRDP still holds the saved one', brdp.title === 'Saved title');
check('typed: blur saves', blurAction(s, brdp, 'title') === 'save');
check('typed: unsaved', hasUnsaved(s));

s = startSave(s, 'b1', 'title', 'New title');
check('saving: blur with the same text does nothing', blurAction(s, brdp, 'title') === 'skip');
const failedOnce = saveFailed(s, 'b1', 'title', 'New title', { message: 'No connection.', retryable: true });
const entry = failedOnce.get(fieldKey('b1', 'title'));
check('failed: the text stays', entry.value === 'New title' && displayedValue(failedOnce, brdp, 'title') === 'New title');
check('failed: marked with the reason', entry.status === 'failed' && entry.error === 'No connection.');
check('failed: retry possible', canRetry(entry));
check('failed: blur with the same text does not send again', blurAction(failedOnce, brdp, 'title') === 'skip');
check('failed: listed', failedEntries(failedOnce).length === 1 && failedEntries(failedOnce, 'other').length === 0);

const succeeded = saveSucceeded(s, 'b1', 'title', 'New title');
check('saved: the entry goes away', !succeeded.has(fieldKey('b1', 'title')));

// An older answer never changes the state of a newer send.
let racing = startSave(editField(new Map(), 'b1', 'title', 'A'), 'b1', 'title', 'A');
racing = startSave(editField(racing, 'b1', 'title', 'AB'), 'b1', 'title', 'AB');
check('an old answer (success) is ignored', saveSucceeded(racing, 'b1', 'title', 'A') === racing);
check('an old answer (failure) is ignored', saveFailed(racing, 'b1', 'title', 'A', { message: 'x', retryable: true }) === racing);
// Typed more while it was on its way: still unsaved, the new text kept.
let more = startSave(editField(new Map(), 'b1', 'title', 'A'), 'b1', 'title', 'A');
more = editField(more, 'b1', 'title', 'ABC');
more = saveSucceeded(more, 'b1', 'title', 'A');
const moreEntry = more.get(fieldKey('b1', 'title'));
check('typed during the save: kept, editing again', moreEntry.value === 'ABC' && moreEntry.status === 'editing');
check('typed during the save: blur saves it', blurAction(more, { ...brdp, title: 'A' }, 'title') === 'save');

// A text the server refused for what it is (422): Retry useless until edited.
let tooLong = startSave(editField(new Map(), 'b1', 'proposal', 'x'.repeat(40000)), 'b1', 'proposal', 'x'.repeat(40000));
tooLong = saveFailed(tooLong, 'b1', 'proposal', 'x'.repeat(40000), { message: 'Too long', retryable: false });
check('422: Retry useless with the same text', !canRetry(tooLong.get(fieldKey('b1', 'proposal'))));
tooLong = editField(tooLong, 'b1', 'proposal', 'short');
check('422: shortened, Retry possible', canRetry(tooLong.get(fieldKey('b1', 'proposal'))));
check('422: shortened, still marked failed until saved', tooLong.get(fieldKey('b1', 'proposal')).status === 'failed');
check('422: shortened, blur saves', blurAction(tooLong, brdp, 'proposal') === 'save');

// Two fields fail at once: independent.
let two = new Map();
for (const f of ['title', 'definition']) {
  two = startSave(editField(two, 'b1', f, `${f} typed`), 'b1', f, `${f} typed`);
  two = saveFailed(two, 'b1', f, `${f} typed`, { message: `${f} failed`, retryable: true });
}
check('two failed fields: two entries', failedEntries(two, 'b1').length === 2);
const oneDiscarded = discardField(two, 'b1', 'title');
check('discard one: the other stays', !oneDiscarded.has(fieldKey('b1', 'title')) && oneDiscarded.get(fieldKey('b1', 'definition')).error === 'definition failed');
check('discard: back to the saved value', displayedValue(oneDiscarded, brdp, 'title') === 'Saved title');
// Retry fails again: still one entry, its latest reason (never piled up).
let again = startSave(two, 'b1', 'title', 'title typed');
again = saveFailed(again, 'b1', 'title', 'title typed', { message: 'still failing', retryable: true });
check('retry fails again: one entry, the latest reason', failedEntries(again, 'b1').length === 2 && again.get(fieldKey('b1', 'title')).error === 'still failing');

// Typed back to the saved text: nothing to save.
check('typed back to the saved text: discard', blurAction(editField(new Map(), 'b1', 'title', 'Saved title'), brdp, 'title') === 'discard');

// Leaving a BRDP: only the failed entries are dropped.
let mixed = editField(two, 'b1', 'proposal', 'still typing');
mixed = editField(mixed, 'b2', 'title', 'other BRDP');
const leftFailed = discardBrdp(mixed, 'b1', { onlyFailed: true });
check('leave: failed entries of that BRDP dropped', failedEntries(leftFailed, 'b1').length === 0);
check('leave: a field being typed stays', leftFailed.has(fieldKey('b1', 'proposal')));
check('leave: another BRDP untouched', leftFailed.has(fieldKey('b2', 'title')));
check('delete BRDP: all its entries dropped', [...discardBrdp(mixed, 'b1').values()].every((e) => e.brdpId !== 'b1'));
check('discardBrdp with nothing to drop: same state', discardBrdp(mixed, 'b9') === mixed);

// Session expired: remembered in memory, reconciled with what was saved.
const pending = startSave(editField(editField(new Map(), 'b1', 'title', 'Saved by then'), 'b1', 'definition', 'Never saved'), 'b1', 'definition', 'Never saved');
rememberUnsaved('p1', pending);
check('remembered per project', recallUnsaved('p1') === pending && recallUnsaved('p2').size === 0);
const reconciled = reconcileWithSaved(recallUnsaved('p1'), [{ ...brdp, title: 'Saved by then' }], 'Not confirmed.');
check('reconcile: a text that was saved goes away', !reconciled.has(fieldKey('b1', 'title')));
const unconfirmed = reconciled.get(fieldKey('b1', 'definition'));
check('reconcile: an unconfirmed save stays failed, text kept', unconfirmed.status === 'failed' && unconfirmed.value === 'Never saved' && unconfirmed.error === 'Not confirmed.' && canRetry(unconfirmed));
check('reconcile: a deleted BRDP drops its entries', reconcileWithSaved(pending, [], 'x').size === 0);
rememberUnsaved('p1', new Map());
check('remember nothing: forgotten', recallUnsaved('p1').size === 0);

// Optimistic delete: back at its place.
const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const removed = removeRow(list, 'b');
check('removeRow: gone, index kept', removed.list.map((r) => r.id).join() === 'a,c' && removed.index === 1 && removed.row.id === 'b');
check('restoreRow: back at its place', restoreRow(removed.list, removed.row, removed.index).map((r) => r.id).join() === 'a,b,c');
check('restoreRow: never twice', restoreRow(list, removed.row, 1) === list);
check('restoreRow: index past the end goes last', restoreRow([{ id: 'a' }], removed.row, 5).map((r) => r.id).join() === 'a,b');
check('removeRow: unknown id, unchanged', removeRow(list, 'z').list === list && removeRow(list, 'z').row === null);

// ── apiErrors ─────────────────────────────────────────────────────────────
const internal = describeErrorDetail(500, { code: 'internal_error', ref: 'abc12345' }, en);
check('internal error: a sentence with the reference', /abc12345/.test(internal) && !/Traceback|Exception/.test(internal), internal);
check('internal error: one period, after the reference', internal.endsWith('(ref. abc12345).') && !/\.\s*\(ref/.test(internal), internal);
check('internal error ES', /ref\. abc12345/.test(describeErrorDetail(500, { code: 'internal_error', ref: 'abc12345' }, es)));
check('a bare reason phrase: the status sentence', describeErrorDetail(502, 'Bad Gateway', en) === describeErrorDetail(502, null, en));
check("a server's own message: as is", describeErrorDetail(409, 'A BRDP with identifier X already exists', en) === 'A BRDP with identifier X already exists');
const tooLongItem = { type: 'string_too_long', loc: ['body', 'proposal'], ctx: { max_length: 32767 }, input: 'x'.repeat(32800) };
const tooLongText = validationItemText(tooLongItem, en);
check('too long: field, length and limit', /Proposal/.test(tooLongText) && /32800/.test(tooLongText) && /32767/.test(tooLongText), tooLongText);
check('too long ES', /Propuesta/.test(validationItemText(tooLongItem, es)) && /32767/.test(validationItemText(tooLongItem, es)));
check('a validation list: one sentence per item', describeErrorDetail(422, [tooLongItem, { type: 'extra_forbidden', loc: ['body', 'history'] }], en).includes('history'));
check('max_tokens over the limit', /16000/.test(describeErrorDetail(422, { code: 'llm_max_tokens_too_high', max: 16000, requested: 99999, ref: null }, en)));
check('an unknown code with a message: the message', describeErrorDetail(409, { code: 'something_new', message: 'Readable.' }, en) === 'Readable.');
const net = networkError(new TypeError('Failed to fetch'), en);
check('network: its own sentence', errorMessage(net, en) === en('errors.network') && net.network);
check('a TypeError from fetch: network', errorMessage(new TypeError('Failed to fetch'), en) === en('errors.network'));
check('isRetryable: network / 5xx / 409', isRetryable(net) && isRetryable(new ApiError('x', { status: 503 })) && isRetryable(new ApiError('x', { status: 409 })));
check('isRetryable: 422 / 403 / 404 / 413 not', [422, 403, 404, 413].every((status) => !isRetryable(new ApiError('x', { status }))));
const coded = new ApiError('x', { status: 500, detail: { code: 'internal_error', ref: 'r1' } });
check('ApiError: code and ref', coded.code === 'internal_error' && coded.ref === 'r1');
check('every errors.codes key exists in ES and EN', ['internal_error', 'database_not_migrated', 'llm_not_configured', 'llm_request_failed', 'llm_upstream_error', 'llm_params_not_allowed', 'llm_messages_invalid', 'llm_temperature_invalid', 'llm_max_tokens_invalid', 'llm_max_tokens_too_high', 'standard_not_supported', 'project_config_not_object', 'project_config_value_not_text'].every((code) => i18n.exists(`errors.codes.${code}`, { lng: 'en' }) && i18n.exists(`errors.codes.${code}`, { lng: 'es' })));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
