import { useTranslation } from 'react-i18next';
import styles from './ErrorNotice.module.css';

/**
 * The one way a failure is shown in Records (AACF 1, Part 1): the existing
 * red role="alert" line (the callout of .ruleErrorText), with the reason --
 * a sentence plus the server's reference, never its technical text
 * (services/apiErrors.js) -- and, when they make sense, Retry and "Discard
 * change". Used under a field that did not save, under the control whose
 * action was undone, and at the top of the page for what is not tied to the
 * selected BRDP.
 *
 * retryDisabledReason: Retry is shown but cannot work yet (a text refused
 * as too long cannot be saved until it is shortened) -- the reason is its
 * tooltip.
 */
export default function ErrorNotice({ message, onRetry, retryDisabledReason, onDiscard, onDismiss, testId }) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <div className={styles.notice} role="alert" data-testid={testId}>
      <span className={styles.text}>{message}</span>
      {(onRetry || onDiscard || onDismiss) && (
        <span className={styles.actions}>
          {onRetry && (
            <button
              type="button"
              className={styles.action}
              onClick={onRetry}
              disabled={!!retryDisabledReason}
              title={retryDisabledReason || undefined}
              data-testid={testId ? `${testId}-retry` : undefined}
            >
              {t('errorNotice.retry')}
            </button>
          )}
          {onDiscard && (
            <button type="button" className={styles.action} onClick={onDiscard} data-testid={testId ? `${testId}-discard` : undefined}>
              {t('errorNotice.discard')}
            </button>
          )}
          {onDismiss && (
            <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label={t('errorNotice.dismiss')}>
              ×
            </button>
          )}
        </span>
      )}
    </div>
  );
}
