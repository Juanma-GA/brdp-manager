import { useTranslation } from 'react-i18next';
import styles from '../../pages/RecordsPage.module.css';

// Docs request (naming-convention tip round), follow-up ("sin Don't show
// again"): a discreet, non-modal box shown next to a field the FIRST time
// the user focuses/types into Title, Definition, Proposal (BRDP panel or
// Add BRDP) or the Ask question -- once per session (state owned by the
// caller, see namingTipAnchor in RecordsPage.jsx). "Got it" is the only
// dismissal -- it hides the tip until the next session (a fresh page
// load), never persisted anywhere (HR1) -- the tip is a genuinely useful
// reminder in an app used only sporadically, so the user decided it
// should always come back rather than be permanently silenceable.
export default function NamingTip({ standard, onGotIt }) {
  const { t } = useTranslation();
  return (
    <div className={styles.namingTip}>
      <p>{t('records.namingTip.text', { standard })}</p>
      <div className={styles.namingTipActions}>
        <button type="button" className={styles.linkButton} onClick={onGotIt}>
          {t('records.namingTip.gotIt')}
        </button>
      </div>
    </div>
  );
}
