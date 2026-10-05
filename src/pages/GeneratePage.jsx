import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { generateBREX } from '../api/generateBREX';
import { generateBREX41 } from '../api/generateBREX41.js';
import { generateBREX301 } from '../api/generateBREX301.js';
import { generateBREXSch } from '../api/generateBREXSch.js';
import { generateSchematronDITA } from '../api/generateSchematronDITA.js';
import { planGeneration, omittedByReason } from '../utils/generatePlan.js';
import styles from './GeneratePage.module.css';

// Same format ids generateBREX*.js already default to internally (see
// each generator's `approvalsFormat` default) -- kept here explicitly
// because this page fetches approvals itself (see below) instead of
// letting the generator do it.
// docs/v2 §1/§2: project.standard is fixed at project creation, is one of
// the 6 exact display strings the Create Project dropdown offers. For the
// three real S1000D standards it no longer maps to exactly one generation
// format: the page offers a BREX / Schematron output selector fed by the
// SAME BREX-format approved rules either way (docs request, confirmed with
// the user) -- there is no independent "Schematron 1.0 — S1000D" standard
// or approval format any more. Schematron output reuses generateBREXSch,
// which generates a real BREX via whichever of these three run functions
// matches the project's standard and converts it deterministically
// (brexToSchematron.js, see CLAUDE.md) -- same reasoning already applied to
// routes/similar.py's kind='rule' standard->format mapping on the backend,
// kept consistent here. S1000D 5.0/6.0 have no entry: no generation engine
// exists for them yet (CLAUDE.md "Lo que NO está implementado todavía").
// DITA 1.3 has its own fixed format, no selector (no BREX equivalent).
const BREX_STANDARDS = {
  'S1000D 4.2': { approvalsFormat: 'BREX-4.2', xsdFormat: '4.2', run: generateBREX },
  'S1000D 4.1': { approvalsFormat: 'BREX-4.1', xsdFormat: '4.1', run: generateBREX41 },
  'S1000D 3.0.1': { approvalsFormat: 'BREX-3.0.1', xsdFormat: '3.0.1', run: generateBREX301 },
};

const DITA_FORMAT_DEF = { approvalsFormat: 'SCH-DITA', xsdFormat: null, run: generateSchematronDITA };

// generateBREX()/generateBREX41()/generateBREX301()/generateBREXSch()/
// generateSchematronDITA() are the untouched core engine (CLAUDE.md) --
// they all accept an `approvals` override (a Map keyed by brdp_id) that
// bypasses their built-in fetchApprovalsMap(), which otherwise targets
// v1's global, unscoped GET /api/approvals/format/:format (no v2
// equivalent: v2's approvals are per-project-BRDP).
//
// This used to be one authFetchJson call PER BRDP run in parallel
// (Promise.all) -- fine for a handful of BRDPs, but a real 575-BRDP
// project (confirmed: Lufthansa) fired 575 simultaneous requests just to
// load the page's own "N BRDPs will be included" counter. Replaced with
// the SAME bulk endpoint (project.js's approvals/{format}/export --
// the "with rule_xml" variant, not the lean one RecordsPage's Rule
// Status sort uses: the engine's approvedBRDPs branch below reads
// `.rule_xml` off each approval to embed the actual rule content, which
// the lean endpoint doesn't carry -- using it here would silently embed
// "undefined" into every generated document) -- one query, fetched once
// when the page loads (not only at Generate time), so the live checkbox
// counters below can use it immediately too.
function useProjectApprovals(projectId, format) {
  // status: 'loading' | 'ready' | 'error'. Generate waits for 'ready': with
  // thousands of rules (SOPTE, 2818) the export takes a moment, and a click
  // before it arrived used to generate a BREX with every rule left out as
  // "pending approval" -- silently (HR7). A failed load is shown, never
  // treated as "no approved rules".
  const [state, setState] = useState({ map: new Map(), status: 'loading', error: null });

  useEffect(() => {
    if (!format) {
      setState({ map: new Map(), status: 'ready', error: null });
      return;
    }
    let cancelled = false;
    setState({ map: new Map(), status: 'loading', error: null });
    authFetchJson(`/api/projects/${projectId}/approvals/${encodeURIComponent(format)}/export`)
      .then((rows) => {
        if (!cancelled) setState({ map: new Map(rows.map((r) => [r.brdp_id, r])), status: 'ready', error: null });
      })
      .catch((err) => {
        console.error(`Failed to fetch bulk approvals for format ${format}:`, err);
        if (!cancelled) setState({ map: new Map(), status: 'error', error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, format]);

  return state;
}

// XSD validation needs a real auth header (/api/validate-brex is behind
// get_current_user), so this page calls it through authFetchJson.
async function validateAgainstXSDAuthed(xml, format) {
  return authFetchJson('/api/validate-brex', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml, format }),
  });
}

export default function GeneratePage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { project } = useOutletContext();

  // Both DITA standards (migration 0013_split_dita_xpath_standards.py --
  // the Rule content is hand-authored XPath 2.0 vs 3.0 separately per
  // project, no shared conversion step) go through the same DITA_FORMAT_DEF;
  // the flavor only matters inside generateSchematronDITA.js itself, which
  // derives the assembled document's queryBinding from project.standard
  // (passed through in the run() call below), not from anything here.
  const isDITA = project.standard === 'DITA 1.3 Xpath2.0' || project.standard === 'DITA 1.3 Xpath3.0';
  const brexDef = BREX_STANDARDS[project.standard];
  // Only the three real S1000D standards offer the BREX/Schematron output
  // choice -- neither DITA standard has a BREX equivalent, and an
  // unimplemented standard (S1000D 5.0/6.0) has nothing to choose between
  // either.
  const hasOutputSelector = !!brexDef;

  const [brdps, setBrdps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [onlyValidated, setOnlyValidated] = useState(true);
  // Docs request: an independent AND filter on Rule Status -- both boxes
  // checked by default (same criterion as onlyValidated's own default).
  const [onlyVerified, setOnlyVerified] = useState(true);
  // 'brex' | 'schematron' -- only meaningful when hasOutputSelector; not
  // persisted anywhere (docs request: switching back and forth in the same
  // session must not require re-approval, but there's no requirement to
  // survive a reload either, and both outputs read the SAME approved rules
  // regardless of this choice, so there is nothing to lose by resetting it).
  const [outputKind, setOutputKind] = useState('brex');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const [xsdValidation, setXsdValidation] = useState(null);
  const generationRef = useRef(0);

  const isSchematronOutput = hasOutputSelector && outputKind === 'schematron';

  // The approvals format is always the project's BREX format id, regardless
  // of outputKind -- a single approved-rules set feeds both outputs (docs
  // request), so switching the selector never re-fetches or invalidates it.
  const formatDef = isDITA
    ? DITA_FORMAT_DEF
    : !brexDef
    ? undefined
    : isSchematronOutput
    ? {
        approvalsFormat: brexDef.approvalsFormat,
        xsdFormat: null,
        run: (brdpsArg, projectConfigArg, options) =>
          generateBREXSch(brdpsArg, projectConfigArg, { ...options, baseGenerator: brexDef.run }),
      }
    : brexDef;
  const isImplemented = !!formatDef;

  // Loaded once on page entry (docs request), not just at Generate time --
  // both the live counter below AND handleGenerate() itself reuse this
  // same state, so toggling either checkbox updates the counter instantly
  // with no network round trip.
  const approvals = useProjectApprovals(projectId, formatDef?.approvalsFormat);
  const approvalsByBrdpId = approvals.map;

  useEffect(() => {
    authFetchJson(`/api/projects/${projectId}/brdps`).then((data) => {
      setBrdps(data);
      setIsLoading(false);
    });
  }, [projectId]);

  useEffect(() => {
    setResult(null);
    setXsdValidation(null);
  }, [onlyValidated, onlyVerified, outputKind]);

  // Which rules go in, and why the others do not -- the same function the
  // generators use (src/utils/generatePlan.js), so the counter is always
  // what enters the document: Proposal Validated (first box) AND rule
  // Verified, or also Draft when the second box is unchecked. A BRDP with
  // no rule never enters as a rule, whatever the boxes say.
  const plan = planGeneration(brdps, approvalsByBrdpId, { onlyValidated, includeDrafts: !onlyVerified });
  const includedCount = plan.included.length;
  // Single source of truth for "which project_config field identifies this
  // project" per standard -- DITA 1.3's Project Configuration page only
  // ever shows/saves projectName (generateSchematronDITA.js reads nothing
  // else from projectConfig); the three real S1000D standards use
  // modelIdentCode (their dmCode construction requires it, and it's the
  // only field their config page ever asks for that identifies the
  // project by name/code). Reused below by isConfigComplete AND
  // handleDownload's filename -- both used to hardcode modelIdentCode
  // regardless of standard, which is exactly what left the Generate button
  // permanently disabled for every DITA project (confirmed live: a freshly
  // created DITA project's project_config never gets a modelIdentCode key,
  // through the UI or the backend's own creation defaults) and, separately,
  // made every DITA download filename read "UNKNOWN_<date>_dita.sch" no
  // matter what the project was actually named (confirmed with a real
  // file -- the .sch's own internal <sch:title> had the real name, only
  // the filename didn't). One shared value here so this "which field per
  // standard" mapping never gets a third, possibly-diverging copy.
  const configIdentifierValue = isDITA
    ? project.project_config?.projectName
    : project.project_config?.modelIdentCode;
  const isConfigComplete = !!configIdentifierValue;

  const handleGenerate = useCallback(async () => {
    if (!formatDef) return;
    setGenerating(true);
    setResult(null);
    setXsdValidation(null);
    const generationId = ++generationRef.current;

    // What goes in and why the rest does not, shown above the output (HR7).
    const report = { drafts: plan.drafts, omitted: omittedByReason(plan) };
    if (plan.included.length === 0) {
      setResult({ xml: null, noRules: true, report });
      setGenerating(false);
      return;
    }

    try {
      // includeDrafts: Draft rules go in too when "Only include Verified
      // XML rules" is unchecked (they used to be left out whatever the box
      // said -- the box only moved the counter).
      // standard: only generateSchematronDITA.js reads this (to pick
      // "xslt2"/"xslt3" for the assembled document's queryBinding and to
      // gate the XPath-3.0-only vocabulary) -- harmless extra key for the
      // BREX/BREX-Schematron generators, which destructure only what they
      // need from this options object.
      const output = await formatDef.run(brdps, project.project_config, {
        onlyValidated,
        includeDrafts: !onlyVerified,
        approvals: approvalsByBrdpId,
        standard: project.standard,
      });
      setResult({ ...output, report });

      if (output?.xml && formatDef.xsdFormat) {
        setXsdValidation({ status: 'validating' });
        validateAgainstXSDAuthed(output.xml, formatDef.xsdFormat)
          .then(({ valid, errors }) => {
            if (generationRef.current === generationId) setXsdValidation({ status: 'done', valid, errors });
          })
          .catch((err) => {
            if (generationRef.current === generationId) setXsdValidation({ status: 'error', message: err.message });
          });
      }
    } catch (err) {
      setResult({ xml: null, valid: false, error: err.message, brdpCount: 0, report });
    } finally {
      setGenerating(false);
    }
  }, [brdps, project.project_config, project.standard, onlyValidated, onlyVerified, formatDef, approvalsByBrdpId, plan]);

  const handleCopy = () => {
    if (!result?.xml) return;
    navigator.clipboard.writeText(result.xml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!result?.xml) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    // configIdentifierValue (projectName for DITA, modelIdentCode for the
    // three S1000D standards -- see its own comment above) -- was
    // previously always modelIdentCode here regardless of standard, which
    // for DITA is never set, so every DITA download silently fell back to
    // "UNKNOWN" no matter the project's real name.
    const mic = configIdentifierValue || 'UNKNOWN';
    const isBREX301 = project.standard === 'S1000D 3.0.1' && !isSchematronOutput;
    const isBREX41 = project.standard === 'S1000D 4.1' && !isSchematronOutput;
    const filename = isDITA
      ? `${mic}_${dateStr}_dita.sch`
      : isSchematronOutput
      ? `${mic}_${dateStr}_s1000d.sch`
      : isBREX301
      ? `DMC-${mic}-00-00-00-00A-022A-D_${dateStr}_301.xml`
      : isBREX41
      ? `DMC-${mic}-00-00-00-00A-022A-A_${dateStr}_41.xml`
      : `DMC-${mic}-00-00-00-00A-022A-A_${dateStr}.xml`;
    const blob = new Blob([result.xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('nav.generate')}</h1>
      <p className={styles.subtitle}>
        {project.name} · {project.standard} · {isLoading ? '…' : `${brdps.length} BRDPs`}
      </p>

      <div className={styles.card}>
        <label className={styles.fieldLabel}>{t('generate.formatLabel')}</label>
        <p className={styles.fixedFormat}>{project.standard || t('generate.noFormatFor', { standard: project.standard })}</p>
        {!isImplemented && (
          <p className={styles.warning}>⚠ {t('generate.notImplemented', { standard: project.standard })}</p>
        )}

        {hasOutputSelector && (
          <>
            <label className={styles.fieldLabel}>{t('generate.outputKindLabel')}</label>
            <div className={styles.outputKindGroup}>
              <button
                type="button"
                className={`${styles.outputKindOption} ${outputKind === 'brex' ? styles.outputKindOptionActive : ''}`}
                onClick={() => setOutputKind('brex')}
              >
                {t('generate.outputKindBrex')}
              </button>
              <button
                type="button"
                className={`${styles.outputKindOption} ${outputKind === 'schematron' ? styles.outputKindOptionActive : ''}`}
                onClick={() => setOutputKind('schematron')}
              >
                {t('generate.outputKindSchematron')}
              </button>
            </div>
            <p className={styles.hint}>{t('generate.outputKindHint')}</p>
          </>
        )}

        <label className={styles.checkboxLabel}>
          <input type="checkbox" checked={onlyValidated} onChange={(e) => setOnlyValidated(e.target.checked)} />
          {t('generate.onlyValidated')}
        </label>
        <label className={styles.checkboxLabel}>
          <input type="checkbox" checked={onlyVerified} onChange={(e) => setOnlyVerified(e.target.checked)} />
          {t('generate.onlyVerified')}
        </label>

        <p className={styles.summary}>{t('generate.summary', { count: includedCount })}</p>

        {!isConfigComplete && <p className={styles.warning}>⚠ {t('generate.configIncomplete')}</p>}
        {(!onlyValidated || !onlyVerified) && (
          <p className={styles.warning}>⚠ {t('generate.notRecommended')}</p>
        )}

        <button
          className={styles.generateBtn}
          onClick={handleGenerate}
          disabled={generating || isLoading || approvals.status !== 'ready' || !isImplemented || !isConfigComplete}
        >
          {generating && <span className={styles.spinner} aria-hidden="true" />}
          {generating ? t('generate.generating') : result ? t('generate.regenerateButton') : t('generate.generateButton')}
        </button>
        {generating && <p className={styles.hint}>{t('generate.generatingHint')}</p>}
        {approvals.status === 'loading' && formatDef && (
          <p className={styles.hint} data-testid="generate-rules-loading">{t('generate.rulesLoading')}</p>
        )}
        {approvals.status === 'error' && (
          <p className={styles.warning} role="alert" data-testid="generate-rules-error">
            ⚠ {t('generate.rulesLoadFailed', { message: approvals.error })}
          </p>
        )}
      </div>

      {result?.noRules && (
        <div className={styles.outputCard}>
          <NoRulesReport report={result.report} />
        </div>
      )}

      {result && !result.noRules && (
        <div className={styles.outputCard}>
          {result.report && <InclusionReport report={result.report} />}
          <div className={styles.outputMeta}>
            <span className={result.valid ? styles.badgeOk : styles.badgeError}>
              {result.valid
                ? `✓ ${t('generate.wellFormed')}`
                : `✗ ${t('generate.xmlError', { error: result.error || (result.errors || []).join('; ') })}`}
            </span>
            {result.ruleCount != null && (
              <span className={styles.countInfo} data-testid="generate-rules-included">
                {t('generate.rulesIncluded', { count: result.ruleCount })}
              </span>
            )}
          </div>

          {formatDef?.xsdFormat && result.xml && (
            <div className={styles.xsdSection}>
              {xsdValidation?.status === 'validating' ? (
                <span className={styles.badgePending}>⧗ {t('generate.validating')}</span>
              ) : xsdValidation?.status === 'error' ? (
                <span className={styles.badgeError}>✗ {t('generate.xsdFailedToRun', { message: xsdValidation.message })}</span>
              ) : xsdValidation?.status === 'done' && xsdValidation.valid ? (
                <span className={styles.badgeOk}>✓ {t('generate.validAgainstXsd')}</span>
              ) : xsdValidation?.status === 'done' && !xsdValidation.valid ? (
                <details>
                  <summary className={styles.badgeError}>
                    ✗ {t('generate.xsdIssues', { count: xsdValidation.errors.length })}
                  </summary>
                  <ul className={styles.errorList}>
                    {xsdValidation.errors.map((e, i) => (
                      <li key={i}>
                        {e.line ? `Line ${e.line}: ` : ''}
                        {e.message}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          )}

          {isDITA && result.xml && result.vocabularyWarnings?.length > 0 && (
            <details className={styles.xsdSection}>
              <summary className={styles.badgePending}>
                ⚠ {t('generate.vocabularyWarnings', { count: result.vocabularyWarnings.length })}
              </summary>
              <ul className={styles.errorList}>
                {result.vocabularyWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          {result.xml && result.schemaUrls && <SchemaUrlReport report={result.schemaUrls} />}

          {result.xml && result.emptyContextBlocks > 0 && (
            <details className={styles.xsdSection} open data-testid="empty-context-blocks">
              <summary className={styles.badgePending}>
                ⚠ {t('generate.emptyContextBlocks', { count: result.emptyContextBlocks })}
              </summary>
              <p className={styles.hint}>{t('generate.emptyContextBlocksHint')}</p>
            </details>
          )}

          {result.xml ? (
            <>
              <pre className={styles.xmlOutput}>{result.xml}</pre>
              <div className={styles.outputActions}>
                <button onClick={handleCopy}>{copied ? t('generate.copied') : t('generate.copy')}</button>
                <button onClick={handleDownload}>{t('generate.download')}</button>
              </div>
            </>
          ) : (
            <div className={styles.errorBox}>{result.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

// A folded list of BRDP identifiers.
function IdentifierList({ brdps }) {
  return (
    <ul className={styles.errorList}>
      {brdps.map((b) => (
        <li key={b.id}>{b.identifier}</li>
      ))}
    </ul>
  );
}

// What went in that was not Verified (amber, on top), and what was left out
// and why, with the box that would change it.
function InclusionReport({ report }) {
  const { t } = useTranslation();
  const { drafts, omitted } = report;
  const groups = [
    { key: 'draft', label: 'omittedDraft', hint: 'omittedDraftHint' },
    { key: 'not_validated', label: 'omittedNotValidated', hint: 'omittedNotValidatedHint' },
    { key: 'no_rule', label: 'omittedNoRule', hint: 'omittedNoRuleHint' },
  ].filter((g) => omitted[g.key].length > 0);
  return (
    <>
      {drafts.length > 0 && (
        <details className={styles.xsdSection} data-testid="generate-drafts-included">
          <summary className={styles.badgePending}>⚠ {t('generate.draftsIncluded', { count: drafts.length })}</summary>
          <p className={styles.hint}>{t('generate.draftsIncludedHint')}</p>
          <IdentifierList brdps={drafts} />
        </details>
      )}
      {groups.map((g) => (
        <details key={g.key} className={styles.xsdSection} data-testid={`generate-omitted-${g.key}`}>
          <summary className={g.key === 'no_rule' ? styles.countInfo : styles.badgePending}>
            {g.key === 'no_rule' ? '' : '⚠ '}
            {t(`generate.${g.label}`, { count: omitted[g.key].length })}
          </summary>
          <p className={styles.hint}>{t(`generate.${g.hint}`)}</p>
          <IdentifierList brdps={omitted[g.key]} />
        </details>
      ))}
    </>
  );
}

// Nothing to generate with these boxes: why, and which box changes it.
function NoRulesReport({ report }) {
  const { t } = useTranslation();
  const { omitted } = report;
  const lines = [
    ['draft', 'omittedDraft', 'omittedDraftHint'],
    ['not_validated', 'omittedNotValidated', 'omittedNotValidatedHint'],
    ['no_rule', 'omittedNoRule', 'omittedNoRuleHint'],
  ].filter(([key]) => omitted[key].length > 0);
  return (
    <div className={styles.xsdSection} role="alert" data-testid="generate-no-rules">
      <p className={styles.badgePending}>⚠ {t('generate.noRulesIncluded')}</p>
      <p className={styles.hint}>{t('generate.noRulesIncludedHint')}</p>
      <ul className={styles.errorList}>
        {lines.map(([key, label, hint]) => (
          <li key={key} data-testid={`generate-no-rules-${key}`}>
            {t(`generate.${label}`, { count: omitted[key].length })}. {t(`generate.${hint}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Generate rewrites the schema URLs of the rules to the project's current
// "Schema location" (output only) -- what it rewrote, and what it left as
// written because it could not recognize it or because the rule mixes schema
// URL forms on purpose (HR7: never silently).
function SchemaUrlReport({ report }) {
  const { t } = useTranslation();
  const { location, rewritten = [], unrecognized = [], mixed = [] } = report;
  if (rewritten.length === 0 && unrecognized.length === 0 && mixed.length === 0) return null;
  const locationName =
    location === 'flat' || location === 'master'
      ? t(`generate.schemaLocationName.${location}`)
      : t('generate.schemaLocationName.custom', { pattern: location });
  return (
    <>
      {rewritten.length > 0 && (
        <details className={styles.xsdSection} data-testid="schema-urls-rewritten">
          <summary className={styles.badgeOk}>
            {t('generate.schemaUrlsRewritten', { count: rewritten.length, location: locationName })}
          </summary>
          <p className={styles.hint}>{t('generate.schemaUrlsRewrittenHint')}</p>
          <ul className={styles.errorList}>
            {rewritten.map((r) => (
              <li key={r.identifier}>
                <strong>{r.identifier}</strong> — {t('generate.schemaUrlValueCount', { count: r.values.length })}
                <ul>
                  {r.values.map((v, i) => (
                    <li key={i}>
                      {t(`generate.schemaUrlWhere.${v.where}`)}: <code>{v.from}</code> → <code>{v.to}</code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
      {mixed.length > 0 && (
        <details className={styles.xsdSection} open data-testid="schema-urls-mixed">
          <summary className={styles.badgePending}>
            ⚠ {t('generate.schemaUrlsMixed', { count: mixed.length })}
          </summary>
          <p className={styles.hint}>{t('generate.schemaUrlsMixedHint')}</p>
          <ul className={styles.errorList}>
            {mixed.map((r) => (
              <li key={r.identifier}>
                <strong>{r.identifier}</strong> —{' '}
                {t('generate.schemaUrlsMixedRule', {
                  forms: r.forms.map((f) => t(`generate.schemaUrlForm.${f}`)).join(', '),
                  values: t('generate.schemaUrlValueCount', { count: r.count }),
                })}
              </li>
            ))}
          </ul>
        </details>
      )}
      {unrecognized.length > 0 && (
        <details className={styles.xsdSection} open data-testid="schema-urls-unrecognized">
          <summary className={styles.badgePending}>
            ⚠ {t('generate.schemaUrlsUnrecognized', { count: unrecognized.length })}
          </summary>
          <p className={styles.hint}>{t('generate.schemaUrlsUnrecognizedHint')}</p>
          <ul className={styles.errorList}>
            {unrecognized.map((r) => (
              <li key={r.identifier}>
                <strong>{r.identifier}</strong>
                <ul>
                  {r.values.map((v, i) => (
                    <li key={i}>
                      {t(`generate.schemaUrlWhere.${v.where}`)}: <code>{v.value}</code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
