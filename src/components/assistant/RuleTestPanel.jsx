import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';
import { useRuleTest } from '../../hooks/useRuleTest';
import { RULE_TEST_FORMATS } from '../../utils/ruleTestEngine.js';
import { displayIndent, displayText, xmlDisplayLines } from '../../utils/ruleTest.js';
import { formatRuleDescription, formatRuleTestReason } from '../../utils/ruleTestReasons.js';
import { contextSchemasOfRule } from '../../utils/ruleSchemaContext.js';
import { formatSchemaIssue, nameIssues, structureIssues } from '../../validation/schemaValidation.js';

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

function verdictView(t, verdict, standard) {
  switch (verdict.kind) {
    case 'correct':
      return { tone: 'ok', text: t('records.ruleTest.verdicts.correct') };
    case 'incorrect':
      return {
        tone: 'bad',
        text: [
          verdict.permissive && t('records.ruleTest.verdicts.permissive'),
          verdict.strict && t('records.ruleTest.verdicts.strict'),
        ]
          .filter(Boolean)
          .join(' '),
      };
    case 'inconclusive':
      return {
        tone: 'warn',
        text: t(verdict.why === 'nothing_selected' ? 'records.ruleTest.verdicts.nothingSelected' : 'records.ruleTest.verdicts.missingExpectation'),
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

const TONE_CLASS = { ok: 'ruleTestToneOk', bad: 'ruleTestToneBad', warn: 'ruleTestToneWarn' };

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
  return problems;
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

function ExampleCard({ example, run, index, standard, dita, showResult, onRunAgain }) {
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
    <div className={styles.ruleTestExample} data-testid={`rule-test-example-${index}`}>
      <div className={styles.ruleTestExampleHead}>
        <strong>{example.label}</strong>
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
      {example.colspecsAdded > 0 && <ColspecsAddedNote count={example.colspecsAdded} />}
      {example.spannedEntriesRemoved?.length > 0 && <SpannedEntriesNote rows={example.spannedEntriesRemoved} />}
      {example.brexReferenceNormalized && (
        <p className={styles.ruleTestNote} data-testid="rule-test-brex-normalized">
          {t('records.ruleTest.brexReferenceNormalized')}
        </p>
      )}
      {!run.validation.runnable && <ValidationProblems validation={run.validation} standard={standard} schema={example.schema} />}
      {showResult && result?.outOfScopeSchemas?.length > 0 && result.status === 'accepted' && example.schema && (
        <p className={styles.ruleTestNote}>{t('records.ruleTest.notApplicable', { schema: example.schema })}</p>
      )}

      {editing ? (
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
          <HighlightedXml lines={lines} xml={example.xml || example.content} />
          <div className={styles.ruleTestExampleActions}>
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

function CorrectionNote({ correction }) {
  const { t } = useTranslation();
  if (!correction) return null;
  const text = correction.failed
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
function RuleDescription({ description }) {
  const { t } = useTranslation();
  const formatted = formatRuleDescription(description, t);
  if (!formatted) return null;
  return (
    <div className={styles.ruleTestDescription} data-testid="rule-test-description">
      <strong>{t('records.ruleTest.describe.title')}</strong>
      <ul className={styles.ruleTestProblems}>
        {formatted.lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
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
// onResult({ result, reason }) receives the result to record (T3; see
// useRuleTest for what is -- and is not -- recorded).
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
  onSuggestCorrectedRule,
  correctedRuleBlockedReason = null,
}) {
  const { t } = useTranslation();
  const { state, analysis, description, verdict, hasEditedExamples, copyablePrompt, generate, regenerate, runAgain, review, reviewFailure, regenerateWithReview } = useRuleTest({
    ruleXml,
    format,
    standard,
    schemaLocation,
    brdp,
    aiProvider,
    vocabulary,
    onResult,
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
  // illustrate either -- no "Show illustrative examples".
  const notARule = analysis.reason?.code === 'rule_format';
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

      <RuleDescription description={description} />

      {state.status === 'idle' && !notARule && !unreachable && (
        <div className={styles.suggestionActions}>
          <button type="button" onClick={() => generate()} data-testid="rule-test-show-examples">
            {t('records.ruleTest.showIllustrativeExamples')}
          </button>
        </div>
      )}
      {state.status === 'loading' && <p className={styles.muted}>{t('records.ruleTest.generating')}</p>}
      {state.status === 'error' && (
        <p className={`${styles.ruleTestVerdict} ${styles.ruleTestToneBad}`} role="alert">
          ⚠ {t(state.badResponse ? 'records.ruleTest.badResponse' : 'records.ruleTest.error', { error: state.error })}
        </p>
      )}

      {state.status === 'ready' && (
        <>
          {!ruleNotExecutable && (
            <p className={`${styles.ruleTestVerdict} ${styles[TONE_CLASS[view.tone]]}`} data-testid="rule-test-verdict">
              {view.text}
            </p>
          )}
          {hasEditedExamples && (
            <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-edited-notice">
              {t('records.ruleTest.editedNotice')}
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
                    schemas: contextSchemasOfRule(ruleXml).schemas,
                    mismatches: review.mismatches,
                    diagnosis: review.explanation,
                  }))
              }
              correctedBlockedReason={correctedRuleBlockedReason}
              busy={!aiProvider}
            />
          )}
          {state.proposalMismatch && (
            <p className={`${styles.ruleTestNote} ${styles.ruleTestToneWarn}`} data-testid="rule-test-mismatch">
              ⚠ {t('records.ruleTest.proposalMismatch', { text: state.proposalMismatch })}
            </p>
          )}
          <CorrectionNote correction={state.correction} />
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
              onRunAgain={(content, metadata) => runAgain(i, content, metadata)}
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
