// project.standard -> rule_approvals format id. Mirrors
// backend/app/api/routes/similar.py's _STANDARD_TO_RULE_FORMAT exactly --
// keep both (and GeneratePage.jsx's separate display-string map) in sync
// if a new standard/format is ever added. Schematron S1000D has no entry:
// it's a BREX-3.0.1 derivative (CLAUDE.md), not a project.standard value
// of its own in v2's model, same reasoning as the backend mapping.
export const STANDARD_TO_RULE_FORMAT = {
  'S1000D 4.2': 'BREX-4.2',
  'S1000D 4.1': 'BREX-4.1',
  'S1000D 3.0.1': 'BREX-3.0.1',
};
