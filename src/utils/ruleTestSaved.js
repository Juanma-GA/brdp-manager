// Guardar la prueba aprobada: the last passed test of a rule, kept with its
// examples (rule_approvals.last_passed_test). Pure (the Node tests import
// it).
// - passedTestPayload: what a passed test sends to be kept -- each example
//   that ran, as it ran (the complete document, what it expected, what the
//   engine gave).
// - savedPassedTest: the kept test as the panel shows it, and whether the
//   rule or the Proposal changed since.
import { ruleXmlHash } from './ruleHash.js';
import { runExample, ruleTestVerdict } from './ruleTest.js';
import { analyzeRule } from './ruleTestEngine.js';
import { thresholdMismatch } from './ruleThreshold.js';
import { verdictToTestRecord } from './ruleTestReasons.js';
import { DOSSIER_MAIN_PATH } from './ruleTestDossier.js';

// The examples of a passed test, as they ran: only the examples the engine
// ran (an example that failed validation is no evidence of anything).
// → { proposal, examples: [...], examples_from? } | null
export function passedTestPayload(examples, runs, proposal, examplesFrom = null) {
  const kept = [];
  (examples || []).forEach((ex, i) => {
    const status = runs?.[i]?.result?.status;
    if (!ex?.xml || (status !== 'accepted' && status !== 'rejected')) return;
    kept.push({
      label: ex.label || '',
      expected: ex.expected,
      schema: ex.schema || null,
      xml: ex.xml,
      skeleton_node_paths: ex.skeletonNodePaths || [],
      result: status,
      matches: runs[i].matches === true,
      // Dosier, Part 2: the dossier's other files, as they ran.
      ...(Array.isArray(ex.files) ? { main_path: ex.mainPath || null, files: ex.files.map((f) => ({ path: f.path, xml: f.xml ?? f.content })) } : {}),
      // Remates: where the content was put and the levels above it, for the
      // skeleton diagnosis when the saved examples are run again.
      ...(ex.skeletonLift ? { skeleton_lift: liftToSaved(ex.skeletonLift) } : {}),
    });
  });
  if (kept.length === 0) return null;
  return { proposal: proposal || '', examples: kept, ...(examplesFrom ? { examples_from: examplesFrom } : {}) };
}

const liftToSaved = (lift) => ({
  insertion: lift.insertion,
  insertion_path: lift.insertionPath,
  levels: lift.levels.map((l) => ({ name: l.name, path: l.path, chain_path: l.chainPath, fits: l.fits === true })),
});
const liftFromSaved = (lift) =>
  lift && Array.isArray(lift.levels)
    ? {
        insertion: lift.insertion,
        insertionPath: lift.insertion_path,
        levels: lift.levels.map((l) => ({ name: l.name, path: l.path, chainPath: l.chain_path, fits: l.fits === true })),
      }
    : null;

// A test record ({ result, reason, ... }) with the examples to keep when it
// passed; any other result is returned as it is.
export function withPassedTest(record, examples, runs, proposal, examplesFrom = null) {
  if (!record || record.result !== 'passed') return record;
  const passedTest = passedTestPayload(examples, runs, proposal, examplesFrom);
  return passedTest ? { ...record, passedTest } : record;
}

const sameText = (a, b) => String(a || '').trim() === String(b || '').trim();

// The kept passed test of a saved rule, for "Ver prueba aprobada" and
// "Probar con los ejemplos guardados":
//   { at, examplesFrom, ruleXml, proposal, editedCount, examples,
//     ruleChanged, proposalChanged } | null
// examples: [{ label, expected, schema, xml, skeletonNodePaths, saved:
// { result, matches } }] -- the shape the panel's example cards take.
// ruleChanged: the saved rule is not the one tested ("probada con una
// versión anterior de la regla"); proposalChanged: the examples were
// written for another Proposal.
export function savedPassedTest(approval, currentProposal = null) {
  const saved = approval?.last_passed_test;
  if (!saved || !Array.isArray(saved.examples) || saved.examples.length === 0) return null;
  return {
    at: saved.at || null,
    examplesFrom: saved.examples_from || null,
    ruleXml: saved.rule_xml || '',
    proposal: saved.proposal || '',
    editedCount: saved.edited_count || 0,
    examples: saved.examples.map((ex) => ({
      label: ex.label || '',
      expected: ex.expected,
      schema: ex.schema || null,
      xml: ex.xml,
      skeletonNodePaths: ex.skeleton_node_paths || [],
      skeletonLift: liftFromSaved(ex.skeleton_lift),
      saved: { result: ex.result, matches: ex.matches === true },
      // Dosier, Part 2 (an older saved test has no files: a single document).
      ...(Array.isArray(ex.files) && ex.files.length > 0
        ? { mainPath: ex.main_path || DOSSIER_MAIN_PATH, content: ex.xml, files: ex.files.map((f) => ({ path: f.path, xml: f.xml, content: f.xml })) }
        : {}),
    })),
    ruleChanged: approval.rule_xml != null && saved.rule_hash !== ruleXmlHash(approval.rule_xml),
    proposalChanged: currentProposal != null && !sameText(saved.proposal, currentProposal),
  };
}

// The date the examples of the kept test were written (an earlier test's,
// when it passed on saved examples).
export function savedExamplesDate(saved) {
  return saved ? saved.examplesFrom || saved.at : null;
}

// "Probar con los ejemplos guardados": the CURRENT rule on the documents of
// the kept test. Only the engine -- no LLM, immediate and deterministic.
//   { examples, runs, verdict, changed, record }
// changed: the indices of the examples whose result is not the one they
// gave in the kept test (what the panel marks). record: what to register --
// a pass keeps the same examples again, dated with the test they came from
// (examples_from), and the Proposal they were written for.
// proposal (Mejoras B, Part 2): the BRDP's current Proposal, for the
// threshold check (defaults to the one the examples were written for).
export function runSavedTest(saved, ruleXml, format, { vocabulary = null, parseXml, schemaLocation = null, proposal = undefined } = {}) {
  const opts = parseXml ? { vocabulary, parseXml, schemaLocation } : { vocabulary, schemaLocation };
  const examples = saved.examples;
  const runs = examples.map((ex) => runExample(ruleXml, format, ex, opts));
  const analysis = analyzeRule(ruleXml, format, parseXml ? { parseXml } : {});
  const threshold = thresholdMismatch(ruleXml, format, proposal === undefined ? saved.proposal : proposal, parseXml ? { parseXml } : {});
  const verdict = ruleTestVerdict(examples, runs, analysis, null, threshold);
  const changed = [];
  runs.forEach((run, i) => {
    if ((run.result?.status || null) !== examples[i].saved?.result) changed.push(i);
  });
  let record = withPassedTest(verdictToTestRecord(verdict), examples, runs, saved.proposal, savedExamplesDate(saved));
  if (record.passedTest && saved.editedCount > 0) {
    record = { ...record, passedTest: { ...record.passedTest, edited_count: saved.editedCount } };
  }
  return { examples, runs, verdict, changed, record };
}
