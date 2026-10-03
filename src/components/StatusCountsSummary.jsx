import { useTranslation } from 'react-i18next';
import styles from './StatusCountsSummary.module.css';

// Shared by two very different call sites, hence the `variant` prop
// (docs request: one component per status type, not duplicated ones) --
// 'full' (default, RecordsPage's header: only one project at a time, so
// the full label reads fine -- "Validated: 36, Pending: 0, Refused: 0")
// vs 'numbersOnly' (ProjectsPage's table: repeating "V"/"P"/"R" on every
// one of 10 rows was pure repetition once the fixed-width columns already
// let the browser's own <colgroup>-free table layout keep numbers
// aligned -- the labels now live once, in the two-level <thead> that
// ProjectsPage.jsx itself owns, not here).
//
// 'numbersOnly' renders the three values as bare <td> siblings (a
// Fragment, no wrapping element) -- it's meant to be spread directly
// inside a <tr>, one <td> per leaf column of that two-level header, so
// real table column layout is what keeps every row's numbers aligned
// (the previous round's <span>-based min-width/tabular-nums trick doesn't
// apply here: each value is its own table cell now, not sharing a cell
// with the other two).
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
function useProposalStatusFields(counts) {
  const { t } = useTranslation();
  return [
    { key: 'validated', label: 'V', className: styles.validated, value: counts.validated, fullLabel: t('records.validationOptions.Validated') },
    { key: 'pending', label: 'P', className: styles.pending, value: counts.pending, fullLabel: t('records.validationOptions.Pending') },
    { key: 'refused', label: 'R', className: styles.refused, value: counts.refused, fullLabel: t('records.validationOptions.Refused') },
  ];
}

function useRuleStatusFields(counts) {
  const { t } = useTranslation();
  return [
    { key: 'verified', label: 'V', className: styles.verified, value: counts.verified, fullLabel: t('records.rule.states.verified') },
    { key: 'draft', label: 'D', className: styles.draft, value: counts.draft, fullLabel: t('records.rule.states.draft') },
    { key: 'todo', label: 'T', className: styles.todo, value: counts.to_do, fullLabel: t('records.rule.states.todo') },
  ];
}

function NumberCells({ fields }) {
  return fields.map((f) => (
    <td key={f.key} className={styles.numCell} title={f.fullLabel}>
      <span className={f.className}>{f.value}</span>
    </td>
  ));
}

function FullSummary({ fields }) {
  const tooltip = fields.map((f) => `${f.fullLabel}: ${f.value}`).join(', ');
  return (
    <span className={styles.summary} title={tooltip}>
      {fields.map((f, i) => (
        <span key={f.key}>
          <span className={f.className}>
            {f.fullLabel}: {f.value}
          </span>
          {i < fields.length - 1 && <span className={styles.sep}>, </span>}
        </span>
      ))}
    </span>
  );
}

export function ProposalStatusSummary({ counts, variant = 'full' }) {
  const fields = useProposalStatusFields(counts);
  return variant === 'numbersOnly' ? <NumberCells fields={fields} /> : <FullSummary fields={fields} />;
}

export function RuleStatusSummary({ counts, variant = 'full' }) {
  const fields = useRuleStatusFields(counts);
  return variant === 'numbersOnly' ? <NumberCells fields={fields} /> : <FullSummary fields={fields} />;
}
