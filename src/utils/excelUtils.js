// Excel files are read and written on the server now (backend
// app/services/excel_io.py, openpyxl): POST .../brdps/import/parse,
// POST .../export.xlsx and GET /api/brdp-template.xlsx. SheetJS (xlsx) is
// gone from the frontend -- 0.18.5 had two high-severity advisories when
// reading a malicious file, and 0.20.3 altered rules with XML entities on
// export. What stays here is the one mapping that does not need it.

// Real, curated per-standard templates (10 real BRDPs each, Rule Status
// Verified with a real Rule already filled in) -- public/ assets, same
// naming convention as the existing brex-schema-summary-*.json files (dots
// in a version number become dashes). ProjectConfigPage.jsx's
// handleDownloadTemplate is the one and only place in the app that reads
// this map (see its own comment) -- do not duplicate this mapping anywhere
// else; backend/app/services/rule_templates.py mirrors it
// (tests/test_standard_consistency.py fails if the two drift).
// S1000D 5.0/6.0 have no generation engine yet (GeneratePage.jsx's
// "Coming soon"), so there is nothing real to show for them -- they, and
// any future standard added here without a curated file yet, get the
// generic template the server builds (GET /api/brdp-template.xlsx).
export const CURATED_TEMPLATE_BY_STANDARD = {
  'S1000D 3.0.1': '/brdp-template-3-0-1.xlsx',
  'S1000D 4.1': '/brdp-template-4-1.xlsx',
  'S1000D 4.2': '/brdp-template-4-2.xlsx',
  'DITA 1.3 Xpath2.0': '/brdp-template-dita-xpath2.xlsx',
  'DITA 1.3 Xpath3.0': '/brdp-template-dita-xpath3.xlsx',
};
