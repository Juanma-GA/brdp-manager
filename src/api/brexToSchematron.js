// brexToSchematron.js
// Conversión determinista S1000D BREX -> ISO Schematron (xslt2 queryBinding).
// Port fiel de s1000d-brex-to-schematron.xsl (Docuneering, Apache-2.0),
// con dos mejoras: (1) preserva el id del BRDP en cada assert (trazabilidad),
// (2) arrastra las reglas sin contexto (comentarios nonContextRule) al .sch.
// Usa DOMParser global (navegador). Para tests Node se puede inyectar options.DOMParserImpl.

function _quote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}
function _normSpace(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function _isPathExpression(path) {
  const t = _normSpace(path);
  return t.startsWith('/') || t.startsWith('//');
}
function _parentPath(path) {
  const t = _normSpace(path);
  const rawParent = t.includes('/') ? t.replace(/\/[^/]+$/, '') : '/';
  const cleanParent = (rawParent !== '/' && rawParent.endsWith('/')) ? rawParent.slice(0, -1) : rawParent;
  return cleanParent === '' ? '/' : cleanParent;
}
function _lastStep(path) {
  const t = _normSpace(path);
  return t.includes('/') ? t.replace(/^.*\//, '') : t;
}
function _isSafePattern(ctx) {
  if (!ctx || !ctx.trim()) return false;
  let p = 0, b = 0, inStr = false, q = '';
  for (let i = 0; i < ctx.length; i++) { const ch = ctx[i];
    if (inStr) { if (ch === q) inStr = false; continue; }
    if (ch === "'" || ch === '"') { inStr = true; q = ch; continue; }
    if (ch === '(') p++; else if (ch === ')') p--; else if (ch === '[') b++; else if (ch === ']') b--;
    if (p < 0 || b < 0) return false;
  }
  if (p !== 0 || b !== 0) return false;
  if (/[|]\s*$|\b(and|or)\s*$/.test(ctx.trim())) return false;
  let depth = 0; inStr = false; q = '';
  for (let i = 0; i < ctx.length; i++) { const ch = ctx[i];
    if (inStr) { if (ch === q) inStr = false; continue; }
    if (ch === "'" || ch === '"') { inStr = true; q = ch; continue; }
    if (ch === '[' || ch === '(') depth++; else if (ch === ']' || ch === ')') depth--;
    else if (depth === 0) {
      if (ch === '.' && ctx[i+1] === '.' && (ctx[i+2] === '/' || ctx[i+2] === undefined || ctx[i+2] === '|' || ctx[i+2] === ' ')) return false;
      const rest = ctx.slice(i); const prev = ctx[i-1];
      if (/^(parent|ancestor|ancestor-or-self|preceding|preceding-sibling|following|following-sibling)::/.test(rest)
          && (i === 0 || prev === '/' || prev === '|' || prev === ' ')) return false;
    }
  }
  return true;
}

function _splitTopLevel(path) {
  const t = _normSpace(path);
  let depth = 0, inStr = false, q = '', lastSep = -1;
  for (let i = 0; i < t.length; i++) { const ch = t[i];
    if (inStr) { if (ch === q) inStr = false; continue; }
    if (ch === "'" || ch === '"') { inStr = true; q = ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === '/' && depth === 0) {
      const isDouble = t[i+1] === '/' || t[i-1] === '/';
      if (i > 1 && !isDouble) lastSep = i;
    }
  }
  if (lastSep <= 0) return null;
  const parent = t.slice(0, lastSep);
  const step = t.slice(lastSep + 1);
  if (!parent || !step) return null;
  return { parent, step };
}

function _getChild(el, names) {
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 1 && names.includes(n.nodeName)) return n;
  }
  return null;
}
function _getChildren(el, names) {
  const out = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 1 && names.includes(n.nodeName)) out.push(n);
  }
  return out;
}
function _attr(el, name) {
  if (!el || !el.getAttribute) return '';
  const v = el.getAttribute(name);
  return v == null ? '' : v;
}
function _escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function _buildValuePredicate(ruleEl, isNamespaceDeclRule, namespacePrefix) {
  const vals = _getChildren(ruleEl, ['objval', 'objectValue']);
  const parts = [];
  for (const v of vals) {
    const valtype = _attr(v, 'valtype');
    const valueFormAttr = _attr(v, 'valueForm');
    const valueForm = valtype !== '' ? valtype : (valueFormAttr !== '' ? valueFormAttr : 'single');
    const val1 = _attr(v, 'val1');
    const valueAllowedAttr = _attr(v, 'valueAllowed');
    const valueAllowed = val1 !== '' ? val1 : valueAllowedAttr;
    const conditionalPath = _normSpace(_attr(v, 'val2')).replace(/"/g, "'");
    const fromValue = val1 !== '' ? val1 : (valueAllowedAttr.split('~')[0] || '');
    const rangeParts = valueAllowedAttr.split('~');
    const toValue = _attr(v, 'val2') !== '' ? _attr(v, 'val2') : (rangeParts[rangeParts.length - 1] || '');
    let p = '(';
    if (isNamespaceDeclRule) {
      p += 'namespace-uri-for-prefix(' + _quote(namespacePrefix) + ', /dmodule) = ' + _quote(valueAllowed);
    } else if (valueForm === 'range') {
      p += 'string(.) ge ' + _quote(fromValue) + ' and string(.) le ' + _quote(toValue);
    } else if (valueForm === 'pattern') {
      const pat = valueAllowedAttr !== '' ? valueAllowedAttr : val1;
      p += 'matches(string(.), ' + _quote(pat) + ')';
    } else {
      p += 'string(.) = ' + _quote(valueAllowed);
    }
    if (!isNamespaceDeclRule && valueForm !== 'range' && conditionalPath.length > 0) {
      p += ' and exists(' + conditionalPath + ')';
    }
    p += ')';
    parts.push(p);
  }
  return parts.join(' or ');
}

function _convertRule(ruleEl, ruleNumber) {
  const objpathEl = _getChild(ruleEl, ['objpath', 'objectPath']);
  const objectPath = _normSpace(objpathEl ? objpathEl.textContent : '').replace(/"/g, "'");
  let objAppl = '2';
  if (objpathEl) {
    const a = _attr(objpathEl, 'objappl') || _attr(objpathEl, 'allowedObjectFlag');
    if (a !== '') objAppl = a;
  }
  const useEl = _getChild(ruleEl, ['objuse', 'objectUse']);
  const ruleMessage = useEl ? useEl.textContent : '';
  let schemaContext = '';
  let p = ruleEl.parentNode;
  while (p && p.nodeType === 1) {
    if (p.nodeName === 'contextrules') { schemaContext = _attr(p, 'context'); break; }
    if (p.nodeName === 'contextRules') { schemaContext = _attr(p, 'rulesContext'); break; }
    p = p.parentNode;
  }
  const isPath = _isPathExpression(objectPath);
  const isNamespaceDeclRule = /^\/dmodule\/@xmlns:[A-Za-z_][A-Za-z0-9._-]*$/.test(objectPath);
  const namespacePrefix = isNamespaceDeclRule ? objectPath.replace(/^\/dmodule\/@xmlns:/, '') : '';
  const hasValueRules = _getChildren(ruleEl, ['objval', 'objectValue']).length > 0;
  const pPath = _parentPath(objectPath);
  const targetStep = _lastStep(objectPath);
  const isNoOpRule = !isPath || ((objAppl !== '0') && (objAppl !== '1') && !hasValueRules);
  const valuePredicate = hasValueRules ? _buildValuePredicate(ruleEl, isNamespaceDeclRule, namespacePrefix) : '';

  let ruleContext;
  if (isNamespaceDeclRule) ruleContext = '/dmodule';
  else if (!isPath) ruleContext = '/';
  else if (objAppl === '0' && hasValueRules) ruleContext = objectPath + '[' + valuePredicate + ']';
  else if (objAppl === '0') ruleContext = objectPath;
  else if (objAppl === '1') ruleContext = pPath;
  else if (hasValueRules) ruleContext = objectPath + '[not(' + valuePredicate + ')]';
  else ruleContext = '/';

  let coreTest;
  if (!isPath) {
    coreTest = 'true()';
  } else if (isNamespaceDeclRule) {
    if (objAppl === '0') {
      coreTest = hasValueRules ? 'not(' + valuePredicate + ')'
        : 'namespace-uri-for-prefix(' + _quote(namespacePrefix) + ", /dmodule) = ''";
    } else if (objAppl === '1') {
      coreTest = hasValueRules ? valuePredicate
        : 'namespace-uri-for-prefix(' + _quote(namespacePrefix) + ", /dmodule) != ''";
    } else {
      coreTest = hasValueRules ? valuePredicate : 'true()';
    }
  } else {
    if (objAppl === '0') coreTest = 'false()';
    else if (objAppl === '1' && targetStep.length > 0 && hasValueRules) coreTest = 'exists(' + targetStep + '[' + valuePredicate + '])';
    else if (objAppl === '1' && targetStep.length > 0) coreTest = 'exists(' + targetStep + ')';
    else if (objAppl === '1' && hasValueRules) coreTest = 'exists(' + objectPath + '[' + valuePredicate + '])';
    else if (objAppl === '1') coreTest = 'exists(' + objectPath + ')';
    else if (hasValueRules) coreTest = 'false()';
    else coreTest = 'true()';
  }

  // objAppl=1: split consciente de corchetes (evita romper rutas con '/' dentro de predicados)
  if (isPath && !isNamespaceDeclRule && objAppl === '1') {
    const sp = _splitTopLevel(objectPath);
    if (sp && _isSafePattern(sp.parent)) {
      ruleContext = sp.parent;
      coreTest = hasValueRules ? 'exists(' + sp.step + '[' + valuePredicate + '])' : 'exists(' + sp.step + ')';
    } else {
      ruleContext = '/dmodule';
      coreTest = hasValueRules ? 'exists(' + objectPath + '[' + valuePredicate + '])' : 'exists(' + objectPath + ')';
    }
  }

  // Robustez general: si el context no es un patrón XSLT válido, mover la ruta al test
  if (isPath && !_isSafePattern(ruleContext)) {
    ruleContext = '/dmodule';
    if (objAppl === '0') {
      coreTest = hasValueRules ? 'not(exists(' + objectPath + '[' + valuePredicate + ']))' : 'not(exists(' + objectPath + '))';
    } else if (objAppl === '1') {
      coreTest = hasValueRules ? 'exists(' + objectPath + '[' + valuePredicate + '])' : 'exists(' + objectPath + ')';
    } else if (hasValueRules) {
      coreTest = 'not(exists(' + objectPath + '[not(' + valuePredicate + ')]))';
    } else {
      coreTest = 'true()';
    }
  }

  let finalTest;
  if (schemaContext.length > 0) {
    finalTest = 'not(//@xsi:noNamespaceSchemaLocation = ' + _quote(schemaContext) + ') or (' + coreTest + ')';
  } else {
    finalTest = coreTest;
  }
  const role = (objAppl === '0' || objAppl === '1') ? 'error' : (isNoOpRule ? 'warning' : 'error');
  return { ruleNumber, seqAssertId: 'BREX-R-' + String(ruleNumber).padStart(4, '0'), seqPatternId: 'brex-r-' + String(ruleNumber).padStart(4, '0'), context: _normSpace(ruleContext), test: _normSpace(finalTest), role, message: ruleMessage };
}

function _collectRules(doc) {
  const all = doc.getElementsByTagName('*');
  const rules = [];
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    if (n.nodeName === 'objrule' || n.nodeName === 'structureObjectRule') rules.push(n);
  }
  return rules;
}
function _carryNonContextComments(brexXml) {
  const re = /<!--\s*nonContextRule id="([^"]+)":\s*([\s\S]*?)-->/g;
  const out = [];
  let m;
  while ((m = re.exec(brexXml)) !== null) {
    const id = m[1];
    const msg = m[2].replace(/--+/g, '-').trim();
    out.push('   <!-- nonContextRule id="' + id + '": ' + msg + ' -->');
  }
  return out;
}

const _SCH_FOOTER = `</sch:schema>`;

function _buildHeader(brexXml) {
  const base = [
    ['xsi', 'http://www.w3.org/2001/XMLSchema-instance'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xlink', 'http://www.w3.org/1999/xlink'],
    ['dc', 'http://www.purl.org/dc/elements/1.1/'],
  ];
  const have = new Set(base.map(x => x[0]));
  const tag = (brexXml.match(/<dmodule\b[^>]*>/) || [''])[0];
  const re = /xmlns:([A-Za-z_][\w.-]*)="([^"]*)"/g; let m; const extra = [];
  while ((m = re.exec(tag)) !== null) { if (!have.has(m[1])) { have.add(m[1]); extra.push([m[1], m[2]]); } }
  const all = base.concat(extra);
  let h = '<?xml version="1.0" encoding="UTF-8"?>\n<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">\n';
  for (const [pfx, u] of all) h += '   <sch:ns prefix="' + pfx + '" uri="' + u + '"/>\n';
  return h;
}

export function brexToSchematron(brexXml, options = {}) {
  const preserveBrdpId = options.preserveBrdpId !== false;
  const carryComments = options.carryComments !== false;
  const DP = options.DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!DP) throw new Error('DOMParser no disponible en este entorno.');
  const doc = new DP().parseFromString(brexXml, 'text/xml');
  const header = _buildHeader(brexXml);
  const rules = _collectRules(doc);
  let body = '';
  rules.forEach((ruleEl, i) => {
    const r = _convertRule(ruleEl, i + 1);
    const srcId = ruleEl.getAttribute && ruleEl.getAttribute('id');
    const assertId = (preserveBrdpId && srcId) ? srcId : r.seqAssertId;
    const patternId = (preserveBrdpId && srcId) ? srcId.toLowerCase() : r.seqPatternId;
    body +=
`   <sch:pattern id="${_escAttr(patternId)}">
      <sch:rule context="${_escAttr(r.context)}">
         <sch:assert id="${_escAttr(assertId)}" role="${r.role}" test="${_escAttr(r.test)}">${_escText(r.message)}</sch:assert>
      </sch:rule>
   </sch:pattern>
`;
  });
  let commentBlock = '';
  if (carryComments) {
    const comments = _carryNonContextComments(brexXml);
    if (comments.length) {
      commentBlock = '   <!-- ===== Reglas sin contexto XPath (solo trazabilidad, no ejecutables) ===== -->\n' + comments.join('\n') + '\n';
    }
  }
  return header + body + commentBlock + _SCH_FOOTER;
}
