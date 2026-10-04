import styles from './ToastContainer.module.css';

/**
 * Toast container component
 * Displays toast notifications in bottom-right corner
 * @param {Object} props - Component props
 * @param {Array} props.toasts - Array of toast objects
 * @returns {JSX.Element} Toast container
 */
export default function ToastContainer({ toasts }) {
  return (
    <div className={styles.container}>
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`${styles.toast} ${styles[toast.type]}`}
          role="alert"
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
