import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authFetchJson } from '../services/apiClient';
import { generateBREX } from '../api/generateBREX';
import { generateBREX41 } from '../api/generateBREX41.js';
import { generateBREX301 } from '../api/generateBREX301.js';
import { generateBREXSch } from '../api/generateBREXSch.js';
import { generateSchematronDITA } from '../api/generateSchematronDITA.js';
import { ruleStateOf } from '../utils/ruleState';
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
  const [approvalsByBrdpId, setApprovalsByBrdpId] = useState(new Map());

  useEffect(() => {
    if (!format) {
      setApprovalsByBrdpId(new Map());
      return;
    }
    let cancelled = false;
    authFetchJson(`/api/projects/${projectId}/approvals/${encodeURIComponent(format)}/export`)
      .then((rows) => {
        if (!cancelled) setApprovalsByBrdpId(new Map(rows.map((r) => [r.brdp_id, r])));
      })
      .catch((err) => {
        console.error(`Failed to fetch bulk approvals for format ${format}:`, err);
        if (!cancelled) setApprovalsByBrdpId(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, format]);

  return approvalsByBrdpId;
}

// XSD validation needs a real auth header (v2's /api/validate-brex is
// behind get_current_user, unlike v1's Express route) -- src/api/
// validateBREX.js is part of the protected core engine (CLAUDE.md) and
// uses a plain unauthenticated fetch, so this page talks to the same
// endpoint directly through authFetchJson instead of importing it.
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

  const isDITA = project.standard === 'DITA 1.3';
  const brexDef = BREX_STANDARDS[project.standard];
  // Only the three real S1000D standards offer the BREX/Schematron output
  // choice -- DITA 1.3 has no BREX equivalent, and an unimplemented
  // standard (S1000D 5.0/6.0) has nothing to choose between either.
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
  const approvalsByBrdpId = useProjectApprovals(projectId, formatDef?.approvalsFormat);

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

  // Proposal Status AND Rule Status, each only applied if its own
  // checkbox is on (docs request: two independent AND conditions, not a
  // single combined toggle) -- reuses ruleStateOf() (src/utils/ruleState.js,
  // already shared with RecordsPage/Export to Excel) rather than a third
  // copy of the same "absence of an approval row = todo" rule.
  const includedCount = brdps.filter((b) => {
    if (onlyValidated && b.validation?.toLowerCase().trim() !== 'validated') return false;
    if (onlyVerified && ruleStateOf(approvalsByBrdpId.get(b.id) ?? null) !== 'verified') return false;
    return true;
  }).length;
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

    try {
      // The engine itself is unconditional here (docs request: don't
      // change it) -- only an 'approved' (Verified) rule ever becomes
      // real rule content; anything else falls to a traceability comment
      // regardless of onlyVerified. onlyVerified only ever affects the
      // live counter above, giving an honest preview of what the engine
      // will actually do, never the generation call itself.
      const output = await formatDef.run(brdps, project.project_config, { onlyValidated, approvals: approvalsByBrdpId });
      setResult(output);

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
      setResult({ xml: null, valid: false, error: err.message, brdpCount: 0 });
    } finally {
      setGenerating(false);
    }
  }, [brdps, project.project_config, onlyValidated, formatDef, approvalsByBrdpId]);

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
          disabled={generating || isLoading || !isImplemented || !isConfigComplete}
        >
          {generating && <span className={styles.spinner} aria-hidden="true" />}
          {generating ? t('generate.generating') : result ? t('generate.regenerateButton') : t('generate.generateButton')}
        </button>
        {generating && <p className={styles.hint}>{t('generate.generatingHint')}</p>}
      </div>

      {result && (
        <div className={styles.outputCard}>
          <div className={styles.outputMeta}>
            <span className={result.valid ? styles.badgeOk : styles.badgeError}>
              {result.valid
                ? `✓ ${t('generate.wellFormed')}`
                : `✗ ${t('generate.xmlError', { error: result.error || (result.errors || []).join('; ') })}`}
            </span>
            {result.brdpCount > 0 && (
              <span className={styles.countInfo}>{t('generate.rulesIncluded', { count: result.brdpCount })}</span>
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
