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

function verdictView(t, verdict) {
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
    default:
      return { tone: 'warn', text: t('records.ruleTest.verdicts.noRunnable') };
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

function ValidationProblems({ validation, standard, schema }) {
  const { t } = useTranslation();
  const problems = [];
  if (validation.unknownSchema) problems.push(t('records.ruleTest.unknownSchema', { schema: validation.unknownSchema }));
  if (!validation.wellFormed) problems.push(t('records.ruleTest.malformed', { error: validation.error }));
  for (const issue of [...nameIssues(validation.names, 'example', { standard }), ...structureIssues(validation.structure, { schema })]) {
    problems.push(formatSchemaIssue(issue, t));
  }
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

function ExampleCard({ example, run, index, standard, dita, showResult, onRunAgain }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(example.content);
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
      {!run.validation.runnable && <ValidationProblems validation={run.validation} standard={standard} schema={example.schema} />}
      {showResult && result?.outOfScopeSchemas?.length > 0 && result.status === 'accepted' && example.schema && (
        <p className={styles.ruleTestNote}>{t('records.ruleTest.notApplicable', { schema: example.schema })}</p>
      )}

      {editing ? (
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
                setDraft(example.content);
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
  const { state, analysis, description, verdict, copyablePrompt, generate, regenerate, runAgain, review, reviewFailure, regenerateWithReview } = useRuleTest({
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

  const view = verdict ? verdictView(t, verdict) : null;
  const showResults = verdict && verdict.kind !== 'not_executable';
  const ruleNotExecutable = analysis.status === 'not_executable';
  // C3, Part 1d: XML that is not a rule of its format has nothing to
  // illustrate either -- no "Show illustrative examples".
  const notARule = analysis.reason?.code === 'rule_format';

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
          {t(notARule ? 'records.ruleTest.analysisNotARule' : ruleNotExecutable ? 'records.ruleTest.analysisNotExecutable' : 'records.ruleTest.analysisPartial', {
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

      {state.status === 'idle' && !notARule && (
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
              key={`${i}:${ex.content}`}
              example={ex}
              run={state.runs[i]}
              index={i}
              standard={standard}
              dita={format === 'SCH-DITA'}
              showResult={showResults}
              onRunAgain={(content) => runAgain(i, content)}
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
