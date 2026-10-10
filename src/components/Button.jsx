import { useCallback, useEffect, useState } from 'react';
import styles from './Button.module.css';

// How long a button stays green after a successful action.
const BUTTON_SUCCESS_MS = 1000;

/**
 * Shared primary-action button (v2 pages only, e.g. SettingsPage's
 * "Save"/"Create user") -- fixed size/padding/height regardless of the
 * parent layout (a CSS grid row would otherwise stretch a plain <button>
 * to match its sibling form fields' height, which is exactly how Profile's
 * Save and User Management's Create user ended up different sizes before
 * this component existed). New forms should use this instead of a
 * per-page `.button` class so they can't diverge the same way again.
 *
 * Action feedback, on the button itself (C3b):
 *   busy      -- disabled, showing `busyLabel` (e.g. "Saving…") while the
 *                action runs, so it cannot be pressed twice;
 *   success   -- green with a ✓ for a moment after the action succeeded
 *                (drive it with useButtonSuccessFlash). Only for success:
 *                a failure is an error message shown next to the button
 *                until the next attempt (HR7), never just a colour.
 */
export default function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  busy = false,
  busyLabel = null,
  success = false,
  disabled = false,
  children,
  ...props
}) {
  const variantClass = styles[variant] || styles.primary;
  const state = busy ? 'busy' : success ? 'success' : undefined;
  return (
    <button
      type={type}
      className={`${styles.button} ${variantClass} ${success && !busy ? styles.success : ''} ${className}`.replace(/\s+/g, ' ').trim()}
      disabled={disabled || busy}
      data-state={state}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy && busyLabel ? (
        busyLabel
      ) : success ? (
        <>
          <span aria-hidden="true" className={styles.check}>
            ✓
          </span>
          {children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

// [success, flash]: call flash() after the action succeeds; success is true
// for `duration` ms (a new flash restarts it).
export function useButtonSuccessFlash(duration = BUTTON_SUCCESS_MS) {
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    if (!stamp) return undefined;
    const timer = setTimeout(() => setStamp(0), duration);
    return () => clearTimeout(timer);
  }, [stamp, duration]);
  const flash = useCallback(() => setStamp(Date.now()), []);
  return [stamp !== 0, flash];
}
