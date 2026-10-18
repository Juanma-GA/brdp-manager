// AACF 3, Part 3 (HR15/HR21): global roles (admin, user) and project roles
// (editor, viewer) are painted through these keys, never as the raw token.
// An unknown role from the server is shown as it is -- never empty.
const KNOWN_ROLES = new Set(['admin', 'user', 'editor', 'viewer']);

export function roleLabel(t, role) {
  if (!role) return '';
  return KNOWN_ROLES.has(role) ? t(`roles.${role}`) : String(role);
}
