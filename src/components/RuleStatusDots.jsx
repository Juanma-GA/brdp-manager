import { useTranslation } from 'react-i18next';
import { RULE_STATES } from '../utils/ruleState';
import styles from '../pages/RecordsPage.module.css';

// Each dot always carries its own state name as title/aria-label (not
// color alone) per the accessibility requirement -- the current step is
// additionally marked via aria-current and a filled style.
export default function RuleStatusDots({ state }) {
  const { t } = useTranslation();
  const currentIndex = RULE_STATES.indexOf(state);
  return (
    <span className={styles.dots}>
      {RULE_STATES.map((s, i) => (
        <span
          key={s}
          role="img"
          className={`${styles.dot} ${i <= currentIndex ? styles.dotFilled : ''} ${
            i === currentIndex ? styles.dotCurrent : ''
          }`}
          title={t(`records.rule.states.${s}`)}
          aria-label={t(`records.rule.states.${s}`)}
          aria-current={i === currentIndex ? 'step' : undefined}
        />
      ))}
    </span>
  );
}
