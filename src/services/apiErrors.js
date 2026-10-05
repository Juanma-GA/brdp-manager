/**
 * Turning a failed request into a sentence for the user (AACF 1, Part 3 --
 * Decisión 12): a clear sentence in the interface language, plus the
 * server's reference ("ref. 1a2b3c4d") when there is one, never the
 * technical text. The detail of an unexpected error is in the server log
 * under that reference (backend app/core/errors.py).
 *
 * What a `detail` can be:
 *   - an object with a `code` (the backend's sanitized and coded errors):
 *     translated from errors.codes.<code>, with its params;
 *   - FastAPI's validation list ([{type, loc, ctx, input}]): one sentence
 *     per item, naming the field and, for a text too long, the limit;
 *   - a string: a message the server wrote for the user (e.g. "A BRDP with
 *     identifier … already exists") -- shown as it is;
 *   - nothing usable: a sentence from the HTTP status.
 * A request that never reached the server (no network, server down) has
 * its own sentence.
 *
 * Pure apart from the default `t` (src/i18n), so it runs in Node tests.
 */
import i18n from '../i18n/index.js';

const defaultT = (key, params) => i18n.t(key, params);

// Request fields named by a validation error -> their label in the UI.
const FIELD_LABEL_KEYS = {
  title: 'records.fieldTitle',
  definition: 'records.fieldDefinition',
  proposal: 'records.fieldProposal',
  comments: 'records.fieldRefusalReason',
  validation: 'records.fieldValidation',
  identifier: 'records.fieldId',
};

// The codes whose sentence is in errors.codes.* (any other code falls back
// to the server's own `message`, or to the status sentence).
export const KNOWN_CODES = new Set([
  'internal_error',
  'database_not_migrated',
  'llm_not_configured',
  'llm_request_failed',
  'llm_upstream_error',
  'llm_params_not_allowed',
  'llm_messages_invalid',
  'llm_temperature_invalid',
  'llm_max_tokens_invalid',
  'llm_max_tokens_too_high',
  'standard_not_supported',
  'project_config_not_object',
  'project_config_value_not_text',
  // AACF 2: projects and users in the Papelera.
  'project_not_found',
  'project_has_running_job',
  'project_name_taken',
  'project_name_empty',
  'trashed_project_not_found',
  'user_deleted_exists',
  'user_email_taken',
  // AACF 3, Part 3: messages seen in normal use (Records, rules, Excel,
  // AI Extract, Papelera, users), coded so they read in the interface
  // language.
  'brdp_not_found',
  'brdp_identifier_taken',
  'brdp_restore_identifier_taken',
  'trashed_brdp_not_found',
  'rule_not_found',
  'rule_test_outdated',
  'rule_test_nothing_to_keep',
  'rule_not_draft',
  'rule_not_verified',
  'embedding_job_running',
  'embedding_unavailable',
  'import_already_running',
  'excel_not_xlsx',
  'excel_corrupt',
  'excel_too_large_uncompressed',
  'excel_wrong_extension',
  'excel_empty',
  'excel_too_large',
  'excel_too_many_rows',
  'extract_file_too_large',
  'extract_no_rule_format',
  'extract_file_empty',
  'extract_not_well_formed',
  'extract_not_xml',
  'extract_schematron_not_expected',
  'extract_schematron_xpath3',
  'extract_dm_not_brex',
  'extract_brex_not_expected',
  'extract_brex_other_issue',
  'extract_brex_unknown_issue',
  'extract_not_rules_file',
  'extract_text_empty',
  'extract_text_too_many_words',
  'extract_text_too_many_chars',
  'extract_already_running',
  'extract_unknown_candidates',
  'extract_not_finished',
  'extract_already_imported',
  'extract_none_selected',
  'user_email_registered',
  'user_not_found',
  'user_last_admin',
  'user_cannot_delete_self',
  'current_password_incorrect',
]);

export class ApiError extends Error {
  constructor(message, { status = null, detail = null, network = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.network = network;
    this.code = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail.code || null : null;
    this.ref = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail.ref || null : null;
  }
}

function fieldLabel(loc, t) {
  const name = Array.isArray(loc) ? loc[loc.length - 1] : loc;
  const key = FIELD_LABEL_KEYS[name];
  return key ? t(key) : String(name ?? '');
}

/** One sentence for one item of FastAPI's validation list. */
export function validationItemText(item, t = defaultT) {
  const field = fieldLabel(item?.loc, t);
  const ctx = item?.ctx || {};
  switch (item?.type) {
    case 'string_too_long':
      return t('errors.validation.tooLong', {
        field,
        max: ctx.max_length,
        length: typeof item.input === 'string' ? item.input.length : '?',
      });
    case 'literal_error':
      return t('errors.validation.notAllowed', { field, allowed: ctx.expected ?? '' });
    case 'extra_forbidden':
      return t('errors.validation.notAccepted', { field });
    case 'missing':
      return t('errors.validation.missing', { field });
    default:
      return t('errors.validation.invalid', { field });
  }
}

function statusText(status, t) {
  if (status === 401) return t('errors.sessionExpired');
  if (status === 403) return t('errors.forbidden');
  if (status === 404) return t('errors.notFound');
  if (status === 409) return t('errors.conflict');
  if (status === 413) return t('errors.tooLarge');
  if (status === 422) return t('errors.invalidRequest');
  if (status >= 500) return t('errors.server', { status });
  return t('errors.requestFailed', { status });
}

/** The sentence for a failed response: its status and its `detail`. */
export function describeErrorDetail(status, detail, t = defaultT) {
  if (Array.isArray(detail) && detail.length > 0) {
    return detail.map((item) => validationItemText(item, t)).join(' ');
  }
  if (detail && typeof detail === 'object') {
    const { code, ref, ...params } = detail;
    if (code && KNOWN_CODES.has(code)) {
      // Job kinds are tokens (import / embeddings / extraction): named in
      // the interface language, never shown raw (HR21).
      if (Array.isArray(params.jobs)) params.jobs = params.jobs.map((kind) => t(`errors.jobKinds.${kind}`, { defaultValue: kind }));
      const text = t(`errors.codes.${code}`, formatParams(params));
      return ref ? t('errors.withRef', { text: text.replace(/\.$/, ''), ref }) : text;
    }
    if (typeof detail.message === 'string' && detail.message) return detail.message;
    const text = statusText(status, t);
    return ref ? t('errors.withRef', { text: text.replace(/\.$/, ''), ref }) : text;
  }
  if (typeof detail === 'string' && detail.trim()) {
    // A bare HTTP reason phrase ("Internal Server Error", from a proxy or a
    // crash outside the app) says nothing more than the status.
    if (/^(internal server error|bad gateway|service unavailable|gateway timeout)$/i.test(detail.trim())) {
      return statusText(status, t);
    }
    return detail;
  }
  return statusText(status, t);
}

// Lists read as comma-separated text in a sentence.
function formatParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** The ApiError for a failed fetch Response (reads its body once). */
export async function apiErrorFromResponse(response, t = defaultT) {
  let detail;
  try {
    const body = await response.json();
    detail = body?.detail ?? null;
  } catch {
    detail = response.statusText || null;
  }
  return new ApiError(describeErrorDetail(response.status, detail, t), { status: response.status, detail });
}

/** The ApiError for a request that never got an answer. */
export function networkError(cause, t = defaultT) {
  return new ApiError(t('errors.network'), { network: true, cause });
}

/**
 * The sentence to show for any caught error: an ApiError's own sentence, a
 * network failure's, or -- for an error that is not a request's (a check
 * in the page itself) -- its message.
 */
export function errorMessage(err, t = defaultT) {
  if (err instanceof ApiError) {
    if (err.network) return t('errors.network');
    return describeErrorDetail(err.status, err.detail, t);
  }
  if (err instanceof TypeError && /fetch|network/i.test(err.message || '')) return t('errors.network');
  return err?.message || t('errors.unknown');
}

/**
 * Whether trying the same request again can work: a network failure, a
 * server error or a conflict can; a request the server refused for what it
 * contains (422, 403, 404, 413) cannot until something changes.
 */
export function isRetryable(err) {
  if (!(err instanceof ApiError)) return true;
  if (err.network) return true;
  return err.status === null || err.status >= 500 || err.status === 409 || err.status === 401 || err.status === 429;
}
