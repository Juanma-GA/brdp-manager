import { useTranslation } from 'react-i18next';
import { RULE_STATES } from '../utils/ruleState';
import styles from '../pages/RecordsPage.module.css';

// Richer variant for the detail panel only (the table keeps the compact
// dots-only RuleStatusDots): all 3 stage labels are always visible,
// connected by a track line, reached stages filled, the current one
// highlighted with the ATEXIS primary color + a halo. The dot itself
// keeps its own title/aria-label/aria-current -- the visible label text
// is an addition for sighted users, not a replacement for it.
export default function RuleStatusStepper({ state }) {
  const { t } = useTranslation();
  const currentIndex = RULE_STATES.indexOf(state);
  return (
    <div className={styles.stepper}>
      {RULE_STATES.map((s, i) => {
        const reached = i <= currentIndex;
        const isCurrent = i === currentIndex;
        return (
          <div key={s} className={styles.stepperStep}>
            {i > 0 && (
              <span className={`${styles.stepperLine} ${reached ? styles.stepperLineFilled : ''}`} />
            )}
            <span
              role="img"
              className={`${styles.stepperDot} ${reached ? styles.stepperDotFilled : ''} ${
                isCurrent ? styles.stepperDotCurrent : ''
              }`}
              title={t(`records.rule.states.${s}`)}
              aria-label={t(`records.rule.states.${s}`)}
              aria-current={isCurrent ? 'step' : undefined}
            />
            <span
              className={`${styles.stepperLabel} ${reached ? styles.stepperLabelReached : ''} ${
                isCurrent ? styles.stepperLabelCurrent : ''
              }`}
            >
              {t(`records.rule.states.${s}`)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
