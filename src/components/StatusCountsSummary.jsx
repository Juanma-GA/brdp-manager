import { useTranslation } from 'react-i18next';
import styles from './StatusCountsSummary.module.css';

// Compact "V 120 · P 45 · R 3"-style summaries -- shared by ProjectsPage's
// two new table columns (Part 1) and RecordsPage's header summary (Part
// 2), so the same real backend counts (GET /api/projects's
// proposal_status_counts/rule_status_counts, GET /brdps/stats) always
// render identically wherever they appear. Full labels only ever live in
// the title/tooltip -- three separate columns per state would be far too
// wide for BRDP Projects' table (docs request).
//
// Colors reuse the app's EXISTING palette, never a new one: Proposal
// Status reuses the exact hex values RecordsPage.module.css's
// .badge_Validated/.badge_Pending/.badge_Refused already use. Rule Status
// has no existing per-state color (the table's RuleStatusDots is a
// progression stepper, not 3 independent categorical counts), so it
// reuses the two tones that stepper/dots already carry for "reached"
// (slate gray) and "current/final" (the app's one blue accent,
// #2563eb -- same blue as .dotCurrent and ProjectsPage's primary button),
// plus one intermediate slate shade from the same Tailwind slate family
// already used throughout (#64748b, already used for subtitle text) for
// the middle "Draft" state.
export function ProposalStatusSummary({ counts }) {
  const { t } = useTranslation();
  const tooltip = `${t('records.validationOptions.Validated')}: ${counts.validated}, ${t(
    'records.validationOptions.Pending'
  )}: ${counts.pending}, ${t('records.validationOptions.Refused')}: ${counts.refused}`;
  return (
    <span className={styles.summary} title={tooltip}>
      <span className={styles.validated}>V {counts.validated}</span>
      <span className={styles.sep}>·</span>
      <span className={styles.pending}>P {counts.pending}</span>
      <span className={styles.sep}>·</span>
      <span className={styles.refused}>R {counts.refused}</span>
    </span>
  );
}

export function RuleStatusSummary({ counts }) {
  const { t } = useTranslation();
  const tooltip = `${t('records.rule.states.verified')}: ${counts.verified}, ${t(
    'records.rule.states.draft'
  )}: ${counts.draft}, ${t('records.rule.states.todo')}: ${counts.to_do}`;
  return (
    <span className={styles.summary} title={tooltip}>
      <span className={styles.verified}>V {counts.verified}</span>
      <span className={styles.sep}>·</span>
      <span className={styles.draft}>D {counts.draft}</span>
      <span className={styles.sep}>·</span>
      <span className={styles.todo}>T {counts.to_do}</span>
    </span>
  );
}
