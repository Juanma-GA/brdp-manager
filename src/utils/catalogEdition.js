// The "4.1" label next to the identifier of a BRDP whose identifier is not
// in the catalog of the project's standard but is in another S1000D
// edition's (catalog_edition, computed by the backend for every BRDP
// response). Pure, importable from Node.

function versionOf(standard) {
  const m = /^S1000D (\d+(?:\.\d+)*)$/.exec(standard || '');
  return m ? m[1].split('.').map(Number) : null;
}

// "S1000D 4.1" → "4.1" (anything else as it is).
export function catalogEditionLabel(edition) {
  return versionOf(edition) ? edition.replace(/^S1000D\s+/, '') : edition || '';
}

// True when the edition is older than the project's standard: the decision
// was retired from the specification after that edition.
export function catalogEditionRetired(edition, standard) {
  const a = versionOf(edition);
  const b = versionOf(standard);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

// Tooltip: "From the S1000D 4.1 catalog. Not in S1000D 4.2 (retired)."
export function catalogEditionTitle(t, edition, standard) {
  return t(catalogEditionRetired(edition, standard) ? 'records.catalogEdition.titleRetired' : 'records.catalogEdition.title', {
    edition,
    standard,
  });
}
