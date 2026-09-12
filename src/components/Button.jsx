import styles from './Button.module.css';

/**
 * Shared primary-action button (v2 pages only, e.g. SettingsPage's
 * "Save"/"Create user") -- fixed size/padding/height regardless of the
 * parent layout (a CSS grid row would otherwise stretch a plain <button>
 * to match its sibling form fields' height, which is exactly how Profile's
 * Save and User Management's Create user ended up different sizes before
 * this component existed). New forms should use this instead of a
 * per-page `.button` class so they can't diverge the same way again.
 */
export default function Button({ variant = 'primary', className = '', type = 'button', ...props }) {
  const variantClass = styles[variant] || styles.primary;
  return <button type={type} className={`${styles.button} ${variantClass} ${className}`.trim()} {...props} />;
}
