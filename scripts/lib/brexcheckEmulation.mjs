// The rule selection and the simple checks of s1kd-brexcheck, for tests and
// verification scripts where the real tool cannot be built (no libxml2
// headers, the repository tarball unreachable). The selection XPath is
// copied verbatim from tools/s1kd-brexcheck/s1kd-brexcheck.c
// (STRUCT_OBJ_RULE_PATH, 6.0.0), with $schema bound -- as there -- to the
// data module's xsi:noNamespaceSchemaLocation:
//   //contextRules[not(@rulesContext) or @rulesContext=$schema]//structureObjectRule|
//   //contextrules[not(@context) or @context=$schema]//objrule
// The objectPath / objpath of each selected rule is then evaluated on the
// data module: flag 0 with nodes is an error, flag 1 without nodes is an
// error, flag 2 (or no objappl) with values: every node must match one value
// (single values only -- enough for these checks).
import fontoxpath from 'fontoxpath';

export const STRUCT_OBJ_RULE_PATH =
  '//contextRules[not(@rulesContext) or @rulesContext=$schema]//structureObjectRule|' +
  '//contextrules[not(@context) or @context=$schema]//objrule';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

// Selected rule elements of a parsed BREX for a schema location string.
export function selectedRules(brexDoc, schema) {
  return fontoxpath.evaluateXPathToNodes(STRUCT_OBJ_RULE_PATH, brexDoc, null, { schema: schema || '' }, { language: fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE });
}

function child(el, name) {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.nodeName === name) return n;
  return null;
}
function children(el, name) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.nodeName === name) out.push(n);
  return out;
}

// [{ id, nodes }] for every selected rule that the data module breaks.
export function brexcheckErrors(brexDoc, dmDoc) {
  const schema = dmDoc.documentElement.getAttributeNS(XSI, 'noNamespaceSchemaLocation') || '';
  const errors = [];
  for (const rule of selectedRules(brexDoc, schema)) {
    const is301 = rule.nodeName === 'objrule';
    const pathEl = child(rule, is301 ? 'objpath' : 'objectPath');
    if (!pathEl) continue;
    const flag = pathEl.getAttribute(is301 ? 'objappl' : 'allowedObjectFlag') || (is301 ? '' : '2');
    const nodes = fontoxpath.evaluateXPathToNodes(pathEl.textContent.trim(), dmDoc, null, {}, { namespaceResolver: (p) => (p === 'xsi' ? XSI : null) });
    const values = children(rule, is301 ? 'objval' : 'objectValue').map((v) => v.getAttribute(is301 ? 'val1' : 'valueAllowed'));
    let broken = false;
    if (flag === '0') broken = values.length ? nodes.some((n) => values.includes(n.nodeValue ?? n.textContent)) : nodes.length > 0;
    else if (flag === '1') broken = nodes.length === 0;
    else if (values.length) broken = nodes.some((n) => !values.includes(n.nodeValue ?? n.textContent));
    if (broken) errors.push({ id: rule.getAttribute('id'), nodes: nodes.length });
  }
  return errors;
}
