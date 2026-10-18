// Stored-rules lint, the Node half of backend/scripts/lint_stored_rules.py:
// the checks live in JS (scripts/lib/ruleLint.mjs, on the rule-test engine
// the "Test rule" panel uses), so the Python script reads the rules from the
// database and hands them over here instead of duplicating the checks.
//
//   stdin:  [{ "key": "...", "format": "BREX-4.2", "rule_xml": "..." }, ...]
//   stdout: { "<key>": [{ "kind", "detail", "known"? }, ...], ... }  (UTF-8)
//
// A rule whose lint throws gets one finding "lint error" with the message --
// never a silent skip (HR7).
import { lintRule } from './lib/ruleLint.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const items = JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]');
const out = {};
for (const { key, format, rule_xml: ruleXml } of items) {
  try {
    out[key] = lintRule(ruleXml || '', format);
  } catch (err) {
    out[key] = [{ kind: 'lint error', detail: String(err?.message || err) }];
  }
}
process.stdout.write(JSON.stringify(out));
