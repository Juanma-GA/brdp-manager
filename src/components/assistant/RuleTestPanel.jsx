import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import VerdictCauseHint from './VerdictCauseHint';
import MinimalDocumentsLine from './MinimalDocumentsLine.jsx';
import { useRuleTest } from '../../hooks/useRuleTest';
import { RULE_TEST_FORMATS } from '../../utils/ruleTestEngine.js';
import { displayIndent, displayText, xmlDisplayLines } from '../../utils/ruleTest.js';
import { acceptCauseText, coverageDetail, engineErrorText, formatRuleDescription, formatRuleTestReason, formatThresholdMismatch, presencePathText } from '../../utils/ruleTestReasons.js';
import { contextSchemasOfRule } from '../../utils/ruleSchemaContext.js';
import { formatSchemaIssue, nameIssues, structureIssues } from '../../validation/schemaValidation.js';
import RuleLintWarnings from './RuleLintWarnings';
import RuleThresholdWarning from './RuleThresholdWarning';
import RulePathWarnings from './RulePathWarnings.jsx';
import RuleReachWarning from './RuleReachWarning.jsx';
import { useRuleReach } from '../../hooks/useRuleReach.js';
import { listElementNames, REACH_LISTED } from '../../validation/ruleRepetition.js';
import { severalUncovered } from '../../validation/ruleRepetition.js';

// Test rule (T2 of 4): which rule formats can be tested (S1000D BREX since
// T1, DITA Schematron since T4). Used by both places that show the button.
export function canTestRule(format) {
  return RULE_TEST_FORMATS.includes(format);
}

// The "Test rule" button, shared by the Suggest Rule suggestion and the
// saved Draft rule.
export function TestRuleButton({ aiProvider, open, onToggle }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onToggle}
      disabled={!aiProvider}
      title={aiProvider ? t('records.ruleTest.buttonTitle') : t('records.ruleTest.noProvider')}
      aria-expanded={open}
    >
      {t('records.ruleTest.button')}
    </button>
  );
}

export function verdictView(t, verdict, standard) {
  switch (verdict.kind) {
    case 'correct':
      return { tone: 'ok', text: t('records.ruleTest.verdicts.correct') };
    // Mejoras E, Part 1: not a defect, not a failure.
    case 'schema_covered':
      return { tone: 'ok', text: t('records.ruleTest.verdicts.schemaCovered', { detail: coverageDetail(verdict.items, t) }) };
    case 'review':
      if (verdict.path) return { tone: 'warn', text: t('records.ruleTest.verdicts.reviewPath', { detail: formatRuleTestReason(verdict.path, t) }) };
      if (verdict.rootAll) return { tone: 'warn', text: t('records.ruleTest.verdicts.reviewRootAll') };
      if (verdict.threshold) return { tone: 'warn', text: t('records.ruleTest.verdicts.reviewThreshold', { detail: formatThresholdMismatch(verdict.threshold, t) }) };
      return verdict.unchecked
        ? { tone: 'warn', text: t('records.ruleTest.verdicts.reviewUnchecked', { error: verdict.error }) }
        : { tone: 'warn', text: t('records.ruleTest.verdicts.review', { mismatch: verdict.mismatch }) };
    case 'incorrect':
      // Mejoras E, Part 2.3: the rule gave an error on a valid example.
      if (verdict.engineErrors?.length) {
        const e = verdict.engineErrors[0];
        return { tone: 'bad', text: t('records.ruleTest.verdicts.engineError', { label: e.label, detail: engineErrorText(e, t) }) };
      }
      // Test de reglas, progreso y causas, Part 1.4: the verdict says the
      // result; which way the rule failed and what to check is said once,
      // right below (VerdictCauseHint).
      return { tone: 'bad', text: t('records.ruleTest.verdicts.failed') };
    case 'inconclusive':
      return {
        tone: 'warn',
        text: [
          t(verdict.why === 'nothing_selected' ? 'records.ruleTest.verdicts.nothingSelected' : 'records.ruleTest.verdicts.missingExpectation'),
          // Mejoras H, Part 1.3
          verdict.schemaLimit && t('records.ruleTest.verdicts.schemaLimit', verdict.schemaLimit),
        ]
          .filter(Boolean)
          .join(' '),
      };
    case 'not_executable':
      return { tone: 'warn', text: t('records.ruleTest.verdicts.notExecutable', { reason: formatRuleTestReason(verdict.reason, t) }) };
    default: {
      // Every example was invalid: name the schema and the reason (the first
      // problem of its first example), never only "regenerate".
      const parts = (verdict.bySchema || []).map(({ schema, count, validation }) => {
        const problems = validationProblemTexts(t, validation, standard, schema);
        return t('records.ruleTest.verdicts.noRunnableSchema', {
          schema: schema || '—',
          count,
          problem: problems[0] || '',
          more: problems.length > 1 ? t('records.ruleTest.verdicts.noRunnableMore', { count: problems.length - 1 }) : '',
        });
      });
      return {
        tone: 'warn',
        text: [t('records.ruleTest.verdicts.noRunnable'), ...parts, t('records.ruleTest.verdicts.noRunnableHint')].join(' '),
      };
    }
  }
}

// The asserts/reports a Schematron rule failed on an example, once each.
function schematronFailedChecks(result) {
  const seen = new Set();
  const out = [];
  for (const v of result?.violations || []) {
    if (!v.check) continue;
    const key = `${v.check.kind}\u0000${v.check.id}\u0000${v.check.test}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v.check);
  }
  return out;
}

// Mejoras F, Part 1.4.
const shortPath = (p) => p.replace(/\[1\]/g, '');
function rejectionText(rejection, t) {
  if (rejection.missing) {
    return rejection.missing.container
      ? t('records.ruleTest.rejectedMissingInside', { target: rejection.missing.target, container: rejection.missing.container })
      : t('records.ruleTest.rejectedMissing', { target: rejection.missing.target });
  }
  const nodes = rejection.nodes.map(shortPath).join(', ');
  const more = rejection.more ? t('records.ruleTest.rejectedMore', { count: rejection.more }) : '';
  const where = rejection.allAppBuilt ? t('records.ruleTest.rejectedAppBuilt', { count: rejection.total }) : '';
  return t('records.ruleTest.rejectedBecause', { nodes: `${nodes}${more}`, where });
}

// Test de reglas, progreso, Part 1.2: what the test is doing now and for how
// long (mm:ss, every second), with Cancel.
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function TestProgress({ state, onCancel }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const step = state.step || 'preparing';
  return (
    <div className={styles.ruleTestProgress} data-testid="rule-test-progress" data-step={step}>
      <span className={styles.muted} data-testid="rule-test-progress-step">
        {step === 'correcting' ? t('records.ruleTest.progress.correcting', { count: state.count || 0 }) : t(`records.ruleTest.progress.${step}`)}
      </span>{' '}
      <span className={styles.ruleTestElapsed} data-testid="rule-test-progress-elapsed">
        {formatElapsed(now - (state.startedAt || now))}
      </span>
      <button type="button" className={styles.linkButton} onClick={onCancel} data-testid="rule-test-cancel">
        {t('records.ruleTest.progress.cancel')}
      </button>
    </div>
  );
}

export const TONE_CLASS = { ok: 'ruleTestToneOk', bad: 'ruleTestToneBad', warn: 'ruleTestToneWarn' };

export function formatTestDate(value, language) {
  if (!value) return '';
  return new Date(value).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
}

// "No sobrescribir una prueba aprobada sin preguntar": the last recorded
// test of this rule passed and this run gave another result -- ask before
// replacing it. After "Keep the previous one", a note says it was kept.
export function ReplacePassedQuestion({ question, answer, onAnswer }) {
  const { t, i18n } = useTranslation();
  if (question) {
    return (
      <div className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} role="alertdialog" data-testid="rule-test-replace-question">
        <p>{t('records.ruleTest.replaceQuestion.text', { date: formatTestDate(question.at, i18n.language) })}</p>
        <div className={styles.suggestionActions}>
          <button type="button" onClick={() => onAnswer(true)} data-testid="rule-test-replace-register">
            {t('records.ruleTest.replaceQuestion.register')}
          </button>
          <button type="button" onClick={() => onAnswer(false)} data-testid="rule-test-replace-keep">
            {t('records.ruleTest.replaceQuestion.keep')}
          </button>
        </div>
      </div>
    );
  }
  if (answer?.kept) {
    return (
      <p className={`${styles.ruleTestNote} ${styles.ruleTestToneOk}`} data-testid="rule-test-replace-kept">
        {t('records.ruleTest.replaceQuestion.kept', { date: formatTestDate(answer.at, i18n.language) })}
      </p>
    );
  }
  return null;
}

// The example's XML, indented, with the nodes the rule selected highlighted
// and (T2b) the application's skeleton dimmed next to the content written
// for the test. The indentation is real spaces (a hanging indent keeps
// wrapped lines aligned), so a selection copies with its structure.
function HighlightedXml({ lines, xml }) {
  if (!lines) return <pre className={styles.ruleTestXml}>{xml}</pre>;
  return (
    <pre className={styles.ruleTestXml}>
      {lines.map((line, i) => (
        <div key={i} style={{ paddingLeft: `${line.depth * 2}ch`, textIndent: `-${line.depth * 2}ch` }}>
          {displayIndent(line.depth)}
          {line.segments.map((seg, j) => {
            const zone = seg.skeleton ? styles.ruleTestSkeleton : styles.ruleTestContent;
            return seg.highlight ? (
              <mark key={j} className={`${styles.ruleTestMark} ${zone}`}>
                {seg.text}
              </mark>
            ) : (
              <span key={j} className={zone}>
                {seg.text}
              </span>
            );
          })}
        </div>
      ))}
    </pre>
  );
}

// Every problem of an example's validation, as text in the UI language.
function validationProblemTexts(t, validation, standard, schema) {
  const problems = [];
  if (validation.unknownSchema) problems.push(t('records.ruleTest.unknownSchema', { schema: validation.unknownSchema }));
  if (validation.missingMetadata) problems.push(t('records.ruleTest.missingMetadata', { element: validation.missingMetadata }));
  if (!validation.wellFormed) problems.push(t('records.ruleTest.malformed', { error: validation.error }));
  for (const issue of [...nameIssues(validation.names, 'example', { standard }), ...structureIssues(validation.structure, { schema })]) {
    problems.push(formatSchemaIssue(issue, t));
  }
  // Dosier, Part 2: the dossier's own problems, then each file's, naming it.
  for (const p of validation.dossierProblems || []) problems.push(t(`records.ruleTest.dossier.problems.${p.code}`, p.params));
  for (const f of validation.files || []) {
    if (f.validation.runnable) continue;
    for (const text of validationProblemTexts(t, f.validation, standard, f.schema)) problems.push(t('records.ruleTest.dossier.inFile', { path: f.path, problem: text }));
  }
  return problems;
}

// Dosier, Part 2: one file of an example's dossier -- its path as the
// header (the ditamap first), collapsible, with the same highlighting, the
// application's fixes, "Copy XML" and, unless read-only, "Edit" / "Run
// again" for that file alone.
function DossierFileBlock({ path, xml, content, selected, skeleton, isMain, fixes, readOnly, onRunAgain, testId }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [copied, setCopied] = useState(false);
  const lines = xml ? xmlDisplayLines(xml, selected || [], undefined, skeleton || []) : null;
  const copyXml = async () => {
    try {
      await navigator.clipboard.writeText(lines ? displayText(lines) : xml || content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <details open className={styles.ruleTestDossierFile} data-testid={testId} data-path={path}>
      <summary>
        <code>{path}</code>
        {isMain && <span className={styles.muted}> — {t('records.ruleTest.dossier.mainFile')}</span>}
      </summary>
      {fixes}
      {editing ? (
        <>
          <textarea
            className={styles.ruleTestEditor}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
            data-testid={`${testId}-editor`}
          />
          <div className={styles.suggestionActions}>
            <button
              onClick={() => {
                onRunAgain(draft);
                setEditing(false);
              }}
            >
              {t('records.ruleTest.runAgain')}
            </button>
            <button
              onClick={() => {
                setDraft(content);
                setEditing(false);
              }}
            >
              {t('records.ruleTest.cancelEdit')}
            </button>
          </div>
        </>
      ) : (
        <>
          <HighlightedXml lines={lines} xml={xml || content} />
          <div className={styles.ruleTestExampleActions}>
            {!readOnly && (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setDraft(content);
                  setEditing(true);
                }}
              >
                {t('records.ruleTest.edit')}
              </button>
            )}
            <button type="button" className={styles.linkButton} onClick={copyXml}>
              {copied ? t('records.ruleTest.xmlCopied') : t('records.ruleTest.copyXml')}
            </button>
          </div>
        </>
      )}
    </details>
  );
}

// The fixes the application made to one document of the example.
function DocumentFixNotes({ doc }) {
  const { t } = useTranslation();
  return (
    <>
      {doc.relocated?.length > 0 && (
        <p className={styles.ruleTestNote} data-testid="rule-test-relocated">
          {t('records.ruleTest.relocated', {
            moves: doc.relocated.map((m) => `<${m.element}> → ${m.path.slice(0, -1).join('/')}`).join('; '),
          })}
        </p>
      )}
      {doc.colspecsAdded > 0 && <ColspecsAddedNote count={doc.colspecsAdded} />}
      {doc.spannedEntriesRemoved?.length > 0 && <SpannedEntriesNote rows={doc.spannedEntriesRemoved} />}
      {doc.colsRaised?.length > 0 && <TableFixNote testId="rule-test-cols-raised" text={t('records.ruleTest.colsRaised', { count: doc.colsRaised.length, values: doc.colsRaised.map((c) => `${c.from} → ${c.to}`).join(', ') })} />}
      {doc.morerowsLowered?.length > 0 && <TableFixNote testId="rule-test-morerows-lowered" text={t('records.ruleTest.morerowsLowered', { count: doc.morerowsLowered.length, rows: [...new Set(doc.morerowsLowered)].join(', ') })} />}
      {doc.emptyRowsRemoved?.length > 0 && <TableFixNote testId="rule-test-empty-rows-removed" text={t('records.ruleTest.emptyRowsRemoved', { count: doc.emptyRowsRemoved.length, rows: doc.emptyRowsRemoved.join(', ') })} />}
    </>
  );
}

// Dosier, Part 2: every file of the example, the ditamap first.
function DossierFiles({ example, selected, readOnly, onRunAgain, testIdPrefix }) {
  const files = example.files || [];
  const runWith = (index, text) => {
    if (index < 0) onRunAgain(text, undefined, files.map((f) => ({ path: f.path, content: f.content })));
    else onRunAgain(example.content, undefined, files.map((f, i) => ({ path: f.path, content: i === index ? text : f.content })));
  };
  return (
    <div className={styles.ruleTestDossier} data-testid={`${testIdPrefix}-dossier`}>
      <DossierFileBlock
        path={example.mainPath}
        xml={example.xml}
        content={example.content}
        selected={selected}
        skeleton={example.skeletonNodePaths}
        isMain
        readOnly={readOnly}
        onRunAgain={(text) => runWith(-1, text)}
        testId={`${testIdPrefix}-file-main`}
      />
      {files.map((f, i) => (
        <DossierFileBlock
          key={`${f.path}:${i}`}
          path={f.path}
          xml={f.xml}
          content={f.content}
          readOnly={readOnly}
          fixes={<DocumentFixNotes doc={f} />}
          onRunAgain={(text) => runWith(i, text)}
          testId={`${testIdPrefix}-file-${i}`}
        />
      ))}
    </div>
  );
}

function ValidationProblems({ validation, standard, schema }) {
  const { t } = useTranslation();
  const problems = validationProblemTexts(t, validation, standard, schema);
  return (
    <div className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`}>
      ⚠ {t('records.ruleTest.notRun')}
      <ul className={styles.ruleTestProblems}>
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

// C3b: the cells the application removed from the example (an <entry> in a
// column a morerows above already covers) -- said, never done silently.
function SpannedEntriesNote({ rows }) {
  const { t } = useTranslation();
  const distinct = [...new Set(rows)].sort((a, b) => a - b);
  const key = distinct.length === 1 ? 'spannedEntriesRemovedRow' : 'spannedEntriesRemovedRows';
  return (
    <p className={styles.ruleTestNote} data-testid="rule-test-app-adjusted">
      {t(`records.ruleTest.${key}`, { count: rows.length, rows: distinct.join(', ') })}
    </p>
  );
}

// C3b follow-up: the colspecs the application added to the example's tables
// (colnames used with no <colspec>) -- said, never done silently.
function ColspecsAddedNote({ count }) {
  const { t } = useTranslation();
  return (
    <p className={styles.ruleTestNote} data-testid="rule-test-colspecs-added">
      {t('records.ruleTest.colspecsAdded', { count })}
    </p>
  );
}

// Barrido final 1/2: the other table fixes the application made itself
// (@cols raised, morerows past the last row lowered, an empty row removed)
// -- said, never done silently.
function TableFixNote({ text, testId }) {
  return (
    <p className={styles.ruleTestNote} data-testid={testId}>
      {text}
    </p>
  );
}

// readOnly (Guardar la prueba aprobada): a kept example -- no Edit, only
// Copy XML.
// previousResult ("Probar con los ejemplos guardados"): the result this
// example gave in the kept test, when the current rule gives another.
export function ExampleCard({ example, run, index, standard, dita, showResult, onRunAgain, readOnly = false, testIdPrefix = 'rule-test-example', previousResult = null }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(example.content);
  // Rule test on DM metadata: the identification and status section the
  // LLM wrote, editable like the content.
  const [metadataDraft, setMetadataDraft] = useState(example.metadata || '');
  const [copied, setCopied] = useState(false);
  const result = run.result;
  const tone = !result || result.status === 'not_executable' ? 'warn' : result.status === 'accepted' ? 'ok' : 'bad';
  const mark = run.matches === true ? ' ✓' : run.matches === false ? ' ✗' : '';
  const lines = example.xml ? xmlDisplayLines(example.xml, showResult && result ? result.selectedNodePaths : [], undefined, example.skeletonNodePaths) : null;

  const copyXml = async () => {
    try {
      await navigator.clipboard.writeText(lines ? displayText(lines) : example.xml || example.content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={styles.ruleTestExample} data-testid={`${testIdPrefix}-${index}`}>
      <div className={styles.ruleTestExampleHead}>
        <strong>{example.label}</strong>
        {/* Mejoras E, Part 1.5: never a label that claims what the corrected example no longer has. */}
        {example.labelNote?.removed?.length > 0 && (
          <span className={`${styles.ruleTestEditedMark} ${styles.ruleTestToneWarn}`} data-testid="rule-test-label-note">
            {t('records.ruleTest.labelRemoved', { names: example.labelNote.removed.map((n) => `<${n}>`).join(', ') })}
          </span>
        )}
        {example.labelNote?.moved?.length > 0 && (
          <span className={`${styles.ruleTestEditedMark} ${styles.ruleTestToneWarn}`} data-testid="rule-test-label-note">
            {t('records.ruleTest.labelMoved', { names: example.labelNote.moved.map((n) => `<${n}>`).join(', ') })}
          </span>
        )}
        {example.editedByUser && (
          <span className={`${styles.ruleTestEditedMark} ${styles.ruleTestToneWarn}`} data-testid="rule-test-edited-mark">
            {t('records.ruleTest.editedMark')}
          </span>
        )}
        {example.schema && (
          <span className={styles.muted}>{t(dita ? 'records.ruleTest.topicType' : 'records.ruleTest.schema', { schema: example.schema })}</span>
        )}
      </div>
      <div className={styles.ruleTestOutcomes}>
        <span>{t('records.ruleTest.expected', { outcome: t(`records.ruleTest.outcomes.${example.expected}`) })}</span>
        {showResult && result && result.status !== 'not_executable' && (
          <span
            className={`${styles.ruleTestResult} ${styles[TONE_CLASS[tone]]}`}
            data-testid="rule-test-result"
            title={run.matches === true ? t('records.ruleTest.asExpected') : run.matches === false ? t('records.ruleTest.notAsExpected') : undefined}
          >
            {t('records.ruleTest.result', { outcome: t(`records.ruleTest.outcomes.${result.status}`) })}
            {mark}
          </span>
        )}
      </div>
      {previousResult && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-result-changed">
          {t('records.ruleTest.saved.resultChanged', {
            before: t(`records.ruleTest.outcomes.${previousResult}`),
            now: result && result.status !== 'not_executable' ? t(`records.ruleTest.outcomes.${result.status}`) : t('records.ruleTest.saved.notRun'),
          })}
        </p>
      )}
      {example.relocated?.length > 0 && (
        <p className={styles.ruleTestNote} data-testid="rule-test-relocated">
          {t('records.ruleTest.relocated', {
            moves: example.relocated.map((m) => `<${m.element}> → ${m.path.slice(0, -1).join('/')}`).join('; '),
          })}
        </p>
      )}
      {example.colspecsAdded > 0 && <ColspecsAddedNote count={example.colspecsAdded} />}
      {example.spannedEntriesRemoved?.length > 0 && <SpannedEntriesNote rows={example.spannedEntriesRemoved} />}
      {example.colsRaised?.length > 0 && <TableFixNote testId="rule-test-cols-raised" text={t('records.ruleTest.colsRaised', { count: example.colsRaised.length, values: example.colsRaised.map((c) => `${c.from} → ${c.to}`).join(', ') })} />}
      {example.morerowsLowered?.length > 0 && <TableFixNote testId="rule-test-morerows-lowered" text={t('records.ruleTest.morerowsLowered', { count: example.morerowsLowered.length, rows: [...new Set(example.morerowsLowered)].join(', ') })} />}
      {example.emptyRowsRemoved?.length > 0 && <TableFixNote testId="rule-test-empty-rows-removed" text={t('records.ruleTest.emptyRowsRemoved', { count: example.emptyRowsRemoved.length, rows: example.emptyRowsRemoved.join(', ') })} />}
      {example.brexReferenceNormalized && (
        <p className={styles.ruleTestNote} data-testid="rule-test-brex-normalized">
          {t('records.ruleTest.brexReferenceNormalized')}
        </p>
      )}
      {example.brexModelIdentFollowed && (
        <p className={styles.ruleTestNote} data-testid="rule-test-brex-model-ident">
          {t('records.ruleTest.brexModelIdentFollowed')}
        </p>
      )}
      {/* Mejoras H, Part 1.2: the correction removed what the schema limits; it was discarded. */}
      {example.schemaLimit && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-schema-limit">
          {t('records.ruleTest.schemaLimitExample', example.schemaLimit)}
        </p>
      )}
      {/* Mejoras E, Part 1.3: the schema already rules this example out. */}
      {run.schemaCovered ? (
        <p className={styles.ruleTestNote} data-testid="rule-test-schema-covered-example">
          {t('records.ruleTest.schemaCoveredExample', { detail: coverageDetail(run.schemaCovered.items, t) })}
        </p>
      ) : (
        !run.validation.runnable && <ValidationProblems validation={run.validation} standard={standard} schema={example.schema} />
      )}
      {/* Mejoras E, Part 2.3: the engine's error on this example, in plain words and as it was given. */}
      {showResult &&
        result?.status === 'error' &&
        (result.runtimeErrors || []).map((e, i) => (
          <div key={`e:${i}`} className={`${styles.ruleTestNote} ${styles.ruleTestToneBad}`} data-testid="rule-test-engine-error">
            <p>{t('records.ruleTest.engineError.onExample', { detail: engineErrorText(e, t) })}</p>
            <p className={styles.muted}>{t('records.ruleTest.engineError.message', { message: e.message })}</p>
          </div>
        ))}
      {showResult && result?.outOfScopeSchemas?.length > 0 && result.status === 'accepted' && example.schema && (
        <p className={styles.ruleTestNote}>{t('records.ruleTest.notApplicable', { schema: example.schema })}</p>
      )}

      {/* Dosier, Part 2: a reference to a file the dossier does not have -- a warning, never an error. */}
      {(run.validation.referenceWarnings || []).map((w, i) => (
        <p key={`rw:${i}`} className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-dossier-reference">
          {t('records.ruleTest.dossier.missingReference', w)}
        </p>
      ))}
      {Array.isArray(example.files) ? (
        <DossierFiles
          example={example}
          selected={showResult && result ? result.selectedNodePaths : []}
          readOnly={readOnly}
          onRunAgain={onRunAgain}
          testIdPrefix={`${testIdPrefix}-${index}`}
        />
      ) : editing ? (
        <>
          {example.metadataElement && (
            <>
              <textarea
                className={styles.ruleTestEditor}
                value={metadataDraft}
                onChange={(e) => setMetadataDraft(e.target.value)}
                spellCheck={false}
                rows={Math.min(14, Math.max(4, metadataDraft.split('\n').length + 1))}
                data-testid="rule-test-metadata-editor"
              />
              <p className={styles.hint}>{t('records.ruleTest.editMetadataHint', { element: example.metadataElement })}</p>
            </>
          )}
          {example.contentInsertion !== false && (
            <>
              <textarea
                className={styles.ruleTestEditor}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
              />
              <p className={styles.hint}>
                {example.insertion
                  ? t('records.ruleTest.editContentHint', { insertion: example.insertion })
                  : t('records.ruleTest.editWholeDocumentHint')}
              </p>
            </>
          )}
          <div className={styles.suggestionActions}>
            <button
              onClick={() => {
                onRunAgain(draft, example.metadataElement ? metadataDraft : undefined);
                setEditing(false);
              }}
            >
              {t('records.ruleTest.runAgain')}
            </button>
            <button
              onClick={() => {
                setDraft(example.content);
                setMetadataDraft(example.metadata || '');
                setEditing(false);
              }}
            >
              {t('records.ruleTest.cancelEdit')}
            </button>
          </div>
        </>
      ) : (
        <>
          {example.rootOnly && (
            <p className={styles.ruleTestNote} data-testid="rule-test-root-only">
              {t('records.ruleTest.rootOnlyExample', { root: example.xml ? rootName(example.xml) : example.schema })}
            </p>
          )}
          {example.minimalDocument && (
            <p className={styles.ruleTestNote} data-testid="rule-test-minimal-document">
              {t(example.presenceTarget ? 'records.ruleTest.minimalDocumentPresence' : 'records.ruleTest.minimalDocumentExample', {
                schema: example.schema,
                root: example.xml ? rootName(example.xml) : '',
                target: example.presenceNames ? presencePathText(example.presenceNames, t) : example.presenceTarget,
              })}
            </p>
          )}
          <HighlightedXml lines={lines} xml={example.xml || example.content} />
          <div className={styles.ruleTestExampleActions}>
            {!example.rootOnly && !example.minimalDocument && !readOnly && (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setDraft(example.content);
                  setMetadataDraft(example.metadata || '');
                  setEditing(true);
                }}
              >
                {t('records.ruleTest.edit')}
              </button>
            )}
            <button type="button" className={styles.linkButton} onClick={copyXml}>
              {copied ? t('records.ruleTest.xmlCopied') : t('records.ruleTest.copyXml')}
            </button>
          </div>
        </>
      )}

      {showResult &&
        result?.status === 'rejected' &&
        result.violations
          .filter((v) => v.message)
          .map((v, i) => (
            <p key={`${v.ruleId}:${i}`} className={`${styles.ruleTestNote} ${styles.ruleTestToneBad}`}>
              {t('records.ruleTest.ruleMessage', { message: v.message })}
            </p>
          ))}
      {/* Mejoras B, Part 3: why the rule accepted an example meant to be
          rejected -- the exact data, so the person decides whether the
          example or the rule is wrong. */}
      {showResult && run?.matches === false && acceptCauseText(run, t) && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneBad} ${styles.ruleTestPre}`} data-testid="rule-test-accept-cause">
          {t('records.ruleTest.acceptedBecause', { cause: acceptCauseText(run, t) })}
        </p>
      )}
      {/* Test de reglas, causas en Schematron (Part 1.3): under any example
          a Schematron rule rejected, each assert that is not met and each
          report that is, by id and expression. */}
      {showResult && result?.status === 'rejected' && schematronFailedChecks(result).length > 0 && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneBad} ${styles.ruleTestPre}`} data-testid="rule-test-sch-cause">
          {t('records.ruleTest.schematronCause', {
            checks: schematronFailedChecks(result)
              .map((c) => t(c.kind === 'report' ? 'records.ruleTest.schematronReportMet' : 'records.ruleTest.schematronAssertNotMet', { id: c.id || '—', test: c.test }))
              .join('; '),
          })}
        </p>
      )}
      {/* Mejoras F, Part 1.4: why the rule rejected an example meant to be
          accepted -- the nodes, and whether they are all the application's.
          A Schematron rule says which check failed instead (above). */}
      {showResult && run?.matches === false && run?.rejection && schematronFailedChecks(result).length === 0 && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneBad} ${styles.ruleTestPre}`} data-testid="rule-test-reject-cause" data-app-built={run.rejection.allAppBuilt ? 'true' : 'false'}>
          {rejectionText(run.rejection, t)}
        </p>
      )}
      {/* Plantillas, Part 4: a rule whose path is a true/false condition
          (s1kd-brexcheck) has no node to highlight -- say whether the
          condition held in this document. */}
      {showResult &&
        result &&
        result.status !== 'not_executable' &&
        (result.conditions || []).map((c, i) => (
          <p key={`c:${c.ruleId}:${i}`} className={styles.ruleTestNote} data-testid="rule-test-condition">
            {t(c.holds ? 'records.ruleTest.conditionHolds' : 'records.ruleTest.conditionNotHolds')}
          </p>
        ))}
      {showResult && run.rejectedByBrexReference && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-brex-rejection">
          {t('records.ruleTest.rejectedByBrexReference')}
        </p>
      )}
      {showResult &&
        (result?.warnings || [])
          .filter((w) => w.message)
          .map((w, i) => (
            <p key={`w:${w.ruleId}:${i}`} className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-rule-warning">
              {t('records.ruleTest.ruleWarning', { message: w.message })}
            </p>
          ))}
    </div>
  );
}

const rootName = (xml) => (/<([A-Za-z_][\w.-]*)/.exec(String(xml).replace(/<\?[\s\S]*?\?>/g, '')) || [])[1] || '';

// Parts of the rule the examples could not test: the document they look
// into has no identification and status section in the application yet.
function UntestedNote({ untested }) {
  const { t } = useTranslation();
  if (!untested || untested.length === 0) return null;
  return untested.map((u) => (
    <p key={u.schema} className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-untested">
      ⚠ {t('records.ruleTest.untestedPart', { names: u.names.join(', '), schema: u.schema, element: u.element })}
    </p>
  ));
}

function CorrectionNote({ correction }) {
  const { t } = useTranslation();
  if (!correction) return null;
  const text = correction.truncated
    ? t('records.ruleTest.correctionTruncated')
    : correction.failed
    ? t('records.ruleTest.correctionFailed', { error: correction.failed })
    : correction.fixed === correction.attempted
      ? t('records.ruleTest.correctedAll', { count: correction.fixed })
      : t('records.ruleTest.correctedSome', { fixed: correction.fixed, attempted: correction.attempted });
  return (
    <p className={styles.ruleTestNote} data-testid="rule-test-correction">
      {text}
    </p>
  );
}

// T3b: what the rule checks, from describeRule (never from the LLM), in the
// interface language; a rule that can never reject anything is flagged.
// Mejoras G, Part 2.3: `presence` (documentPresence) adds the schemas
// where the element can never exist -- the rule always rejects them.
// Mejoras G, Part 2.1: `reach` (starReach) -- the elements a "*[@a]" step
// reaches, up to REACH_LISTED by name, more as a number.
function RuleDescription({ description, presence = null, reach = [] }) {
  const { t, i18n } = useTranslation();
  const formatted = formatRuleDescription(description, t);
  if (!formatted) return null;
  const reachLines = reach.map((r) =>
    r.elements.length > REACH_LISTED
      ? t('records.ruleTest.reach.count', { path: r.path, count: r.elements.length })
      : t('records.ruleTest.reach.list', { path: r.path, names: listElementNames(r.elements, i18n.language) })
  );
  const neverThere =
    presence && presence.always.length > 0 && presence.cannot.length > 0
      ? t('records.ruleTest.describe.presenceNever', {
          schemas: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(presence.cannot),
          target: presencePathText(presence.names, t),
        })
      : null;
  return (
    <div className={styles.ruleTestDescription} data-testid="rule-test-description">
      <strong>{t('records.ruleTest.describe.title')}</strong>
      <ul className={styles.ruleTestProblems}>
        {formatted.lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
        {reachLines.map((line, i) => (
          <li key={`reach-${i}`} data-testid="rule-test-reach">
            {line}
          </li>
        ))}
        {neverThere && <li data-testid="rule-test-presence-never">{neverThere}</li>}
      </ul>
      {formatted.cannotReject && (
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneBad}`} data-testid="rule-test-cannot-reject">
          ⚠ {t('records.ruleTest.describe.cannotReject')}
        </p>
      )}
    </div>
  );
}

// T3b "Review with the assistant": shown only with an incorrect verdict.
// Indicative; its actions start a new test or a new suggestion, never
// change the recorded result.
function ReviewSection({ review, onReview, onRegenerate, onSuggestCorrected, correctedBlockedReason, busy }) {
  const { t } = useTranslation();
  if (!review) {
    return (
      <div className={styles.suggestionActions}>
        <button type="button" onClick={onReview} disabled={busy} data-testid="rule-test-review">
          {t('records.ruleTest.review.button')}
        </button>
      </div>
    );
  }
  if (review.status === 'loading') return <p className={styles.muted}>{t('records.ruleTest.review.loading')}</p>;
  if (review.status === 'error') {
    return (
      <div>
        <p className={`${styles.ruleTestNote} ${styles.ruleTestToneBad}`} role="alert">
          ⚠ {t('records.ruleTest.review.error', { error: review.error })}
        </p>
        <div className={styles.suggestionActions}>
          <button type="button" onClick={onReview}>
            {t('records.ruleTest.review.retry')}
          </button>
        </div>
      </div>
    );
  }
  const showRegenerate = review.cause === 'example' || review.cause === 'unclear';
  const showCorrect = (review.cause === 'rule' || review.cause === 'unclear') && onSuggestCorrected;
  return (
    <div className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-review-result" data-cause={review.cause}>
      <p className={styles.ruleTestExplanation}>
        <strong>{t(`records.ruleTest.review.causes.${review.cause}`)}</strong>{' '}
        {t('records.ruleTest.review.indicative', { text: review.explanation })}
      </p>
      <div className={styles.suggestionActions}>
        {showRegenerate && (
          <button type="button" onClick={onRegenerate} data-testid="rule-test-regenerate-with-review">
            {t('records.ruleTest.review.regenerate')}
          </button>
        )}
        {showCorrect && (
          <button
            type="button"
            onClick={onSuggestCorrected}
            disabled={Boolean(correctedBlockedReason)}
            title={correctedBlockedReason || t('records.ruleTest.review.suggestCorrectedTitle')}
            data-testid="rule-test-suggest-corrected"
          >
            {t('records.ruleTest.review.suggestCorrected')}
          </button>
        )}
      </div>
    </div>
  );
}

// The panel: what cannot be tested first (T2b: known before any example),
// then the verdict, the explanation and each example. Opened by
// TestRuleButton; mounted with key={rule} so another rule starts afresh.
// onResult({ result, reason, editedExamples? }) receives the result to
// record (T3; see useRuleTest for what is -- and is not -- recorded) and may
// return (a promise of) whether it was saved. recordsOnAccept: a
// suggestion's test is recorded when the rule is accepted, so the notice
// about a corrected test says so.

// onSuggestCorrectedRule({ ruleXml, schemas, mismatches, diagnosis }) (T3b)
// starts Suggest Rule with the failed test in its prompt; absent where the
// panel cannot offer it, disabled with correctedRuleBlockedReason.
export default function RuleTestPanel({
  ruleXml,
  format,
  standard,
  schemaLocation,
  brdp,
  aiProvider,
  vocabulary,
  onClose,
  onResult,
  approval = null,
  onKeepPrevious = null,
  recordsOnAccept = false,
  onSuggestCorrectedRule,
  correctedRuleBlockedReason = null,
}) {
  const { t } = useTranslation();
  const reach = useRuleReach(ruleXml, format, standard, schemaLocation);
  const {
    state,
    analysis,
    description,
    verdict,
    editNotice,
    copyablePrompt,
    generate,
    regenerate,
    cancel,
    cancelled,
    runAgain,
    review,
    reviewFailure,
    regenerateWithReview,
    replaceQuestion,
    replaceAnswer,
    answerReplaceQuestion,
  } = useRuleTest({
    ruleXml,
    format,
    standard,
    schemaLocation,
    brdp,
    aiProvider,
    vocabulary,
    onResult,
    approval,
    onKeepPrevious,
  });
  const [copyStatus, setCopyStatus] = useState(null);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(copyablePrompt);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  const view = verdict ? verdictView(t, verdict, standard) : null;
  const showResults = verdict && verdict.kind !== 'not_executable';
  const ruleNotExecutable = analysis.status === 'not_executable';
  // C3, Part 1d: XML that is not a rule of its format has nothing to
  // illustrate either -- no "Show illustrative examples". Same for a rule
  // whose every part sits in a context block with an empty rulesContext: it
  // applies to no schema, so no example could ever run it.
  const notARule = analysis.reason?.code === 'rule_format' || analysis.reason?.code === 'empty_schema_context';
  // Rule test on DM metadata, Part 3: nothing to illustrate either -- the
  // examples cannot contain what the rule looks at.
  const unreachable = Boolean(analysis.unreachable);

  return (
    <section className={styles.ruleTestPanel} aria-label={t('records.ruleTest.title')} data-testid="rule-test-panel">
      <div className={styles.ruleTestHead}>
        <h4 className={styles.ruleTestTitle}>{t('records.ruleTest.title')}</h4>
        <button type="button" className={styles.linkButton} onClick={onClose}>
          {t('records.ruleTest.close')}
        </button>
      </div>

      {analysis.status !== 'executable' && (
        <p className={`${styles.ruleTestVerdict} ${styles.ruleTestToneWarn}`} data-testid="rule-test-analysis">
          {t(
            unreachable
              ? 'records.ruleTest.analysisUnreachable'
              : notARule
                ? 'records.ruleTest.analysisNotARule'
                : ruleNotExecutable
                  ? 'records.ruleTest.analysisNotExecutable'
                  : 'records.ruleTest.analysisPartial',
            {
            reason: formatRuleTestReason(analysis.reason, t),
          })}
        </p>
      )}

      {(analysis.warnings || []).map((w) => (
        <p key={w.code} className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-analysis-warning">
          ⚠ {formatRuleTestReason(w, t)}
        </p>
      ))}

      {state.status !== 'ready' && <ReplacePassedQuestion question={replaceQuestion} answer={replaceAnswer} onAnswer={answerReplaceQuestion} />}

      <RuleDescription description={description} presence={state.presence || null} reach={reach} />
      <MinimalDocumentsLine ruleXml={ruleXml} format={format} standard={standard} schemaLocation={schemaLocation} testId="rule-test-minimal-documents" />
      {!notARule && <RuleLintWarnings ruleXml={ruleXml} format={format} place="panel" standard={standard} />}
      {/* Mejoras C, Part 1: once the test says "review" for it, the verdict
          carries the same text. */}
      {!notARule && state.status !== 'path_review' && (
        <RulePathWarnings ruleXml={ruleXml} format={format} standard={standard} schemaLocation={schemaLocation} testId="rule-test-path-warning" />
      )}
      {/* Mejoras B, Part 2: shown here unless the verdict already says it. */}
      {!notARule && !verdict?.threshold && <RuleThresholdWarning ruleXml={ruleXml} format={format} proposal={brdp?.proposal} />}
      {!notARule && <RuleReachWarning ruleXml={ruleXml} format={format} standard={standard} schemaLocation={schemaLocation} proposal={brdp?.proposal} testId="rule-test-reach-warning" />}

      {state.status === 'idle' && !notARule && !unreachable && (
        <div className={styles.suggestionActions}>
          <button type="button" onClick={() => generate()} data-testid="rule-test-show-examples">
            {t('records.ruleTest.showIllustrativeExamples')}
          </button>
        </div>
      )}
      {state.status === 'loading' && <TestProgress state={state} onCancel={cancel} />}
      {cancelled && state.status !== 'loading' && (
        <p className={`${styles.ruleTestNote} ${styles.muted}`} data-testid="rule-test-cancelled">
          {t('records.ruleTest.progress.cancelled')}
        </p>
      )}
      {state.status === 'path_review' && (
        <>
          <p className={`${styles.ruleTestVerdict} ${styles.ruleTestToneWarn}`} data-testid="rule-test-verdict" data-kind="review" data-reason="test_impossible_path">
            {view.text}
          </p>
        </>
      )}
      {state.status === 'error' && (
        <p className={`${styles.ruleTestVerdict} ${styles.ruleTestToneBad}`} role="alert">
          ⚠ {state.truncated
            ? t('records.ruleTest.truncated')
            : t(state.badResponse ? 'records.ruleTest.badResponse' : 'records.ruleTest.error', { error: state.error })}
        </p>
      )}

      {state.status === 'ready' && (
        <>
          {!ruleNotExecutable && (
            <p className={`${styles.ruleTestVerdict} ${styles[TONE_CLASS[view.tone]]}`} data-testid="rule-test-verdict" data-kind={verdict.kind}>
              {view.text}
            </p>
          )}
          {!ruleNotExecutable && <VerdictCauseHint verdict={verdict} runs={state.runs} />}
          {verdict?.engineErrors?.length > 0 && (
            <p className={`${styles.ruleTestNote} ${styles.muted}`} data-testid="rule-test-engine-message">
              {t('records.ruleTest.engineError.message', { message: verdict.engineErrors[0].message })}
            </p>
          )}
          {/* Mejoras E, Part 1.4: why there is no example meant to be rejected. */}
          {state.coverage && (
            <p className={styles.ruleTestNote} data-testid="rule-test-no-reject-example">
              {t('records.ruleTest.noRejectExample', { detail: coverageDetail(state.coverage.items, t) })}
            </p>
          )}
          <ReplacePassedQuestion question={replaceQuestion} answer={replaceAnswer} onAnswer={answerReplaceQuestion} />
          {editNotice?.kind === 'not_saved' && (
            <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-edited-notice" data-kind="not_saved">
              {t('records.ruleTest.editedNotice')}
            </p>
          )}
          {editNotice?.kind === 'recorded' && (
            <p className={`${styles.ruleTestNote} ${styles.ruleTestToneOk}`} data-testid="rule-test-edited-notice" data-kind="recorded">
              {t(recordsOnAccept ? 'records.ruleTest.editedRecordedOnAccept' : 'records.ruleTest.editedRecorded', { count: editNotice.count })}
            </p>
          )}
          {verdict?.kind === 'incorrect' && (
            <ReviewSection
              review={review}
              onReview={reviewFailure}
              onRegenerate={regenerateWithReview}
              onSuggestCorrected={
                onSuggestCorrectedRule &&
                (() =>
                  onSuggestCorrectedRule({
                    ruleXml,
                    schemas: contextSchemasOfRule(ruleXml, schemaLocation).schemas,
                    mismatches: review.mismatches,
                    diagnosis: review.explanation,
                    examples: state.examples,
                  }))
              }
              correctedBlockedReason={correctedRuleBlockedReason}
              busy={!aiProvider}
            />
          )}
          {state.proposalCheck?.status === 'mismatch' && verdict?.kind !== 'review' && (
            <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-mismatch">
              ⚠ {t('records.ruleTest.proposalMismatch', { text: state.proposalCheck.missing })}
            </p>
          )}
          {state.proposalCheck?.status === 'partial' && (
            <p className={`${styles.ruleTestNote} ${styles.ruleTestToneNeutral}`} data-testid="rule-test-partial">
              {t('records.ruleTest.proposalPartial', { text: state.proposalCheck.reason })}
            </p>
          )}
          <CorrectionNote correction={state.correction} />
          {state.predicateSkipped > 0 && (
            <p className={styles.ruleTestNote} data-testid="rule-test-predicate-skipped">
              {t('records.ruleTest.predicateSkipped', { count: state.predicateSkipped })}
            </p>
          )}
          <UntestedNote untested={state.untested} />
          {severalUncovered(state.several, state.examples, state.runs).map((element) => (
            <p key={element} className={`${styles.ruleTestNote} ${styles.ruleTestToneNeutral}`} data-testid="rule-test-several-uncovered">
              {t('records.ruleTest.repetition.severalUncovered', { element: `<${element}>` })}
            </p>
          ))}
          <p className={styles.hint}>{t('records.ruleTest.skeletonLegend')}</p>
          {state.examples.map((ex, i) => (
            <ExampleCard
              // An edit replaces the example's content: remount the card so
              // its draft starts from the new text.
              key={`${i}:${ex.content}:${ex.metadata || ''}`}
              example={ex}
              run={state.runs[i]}
              index={i}
              standard={standard}
              dita={format === 'SCH-DITA'}
              showResult={showResults}
              onRunAgain={(content, metadata, files) => runAgain(i, content, metadata, files)}
            />
          ))}
        </>
      )}

      {state.status !== 'loading' && state.status !== 'idle' && (
        <div className={styles.suggestionActions}>
          <button onClick={() => regenerate()}>{t('records.ruleTest.regenerate')}</button>
          {copyablePrompt && (
            <button onClick={copyPrompt} title={t('records.ruleTest.copyPromptTitle')}>
              {copyStatus === 'copied' ? t('records.assistant.promptCopied') : t('records.ruleTest.copyPrompt')}
            </button>
          )}
        </div>
      )}
      {copyStatus === 'failed' && <p className={styles.muted}>{t('records.assistant.promptCopyFailed')}</p>}
    </section>
  );
}
