// Barrido final 2/2, Part 6: the two functions that edit XML as TEXT --
// normalizeBrexReferenceCode (src/utils/ruleTestSkeleton.js: the brexDmRef's
// code follows the data module's own) and unwrapRuleXml
// (src/utils/ruleWrappers.js: legacy wrappers around a stored rule) -- on
// rare but valid input: comments and CDATA that contain markup, single
// quotes, attributes in another order, ">" in an attribute value; and
// malformed input (never an exception). Every valid input must give valid
// XML, and comments / CDATA must come out byte for byte.
// unwrapRuleXml's cases are shared with its Python twin
// (backend/tests/fixtures/rule_wrapper_cases.json, run by
// scripts/test-rule-wrappers.mjs and backend/tests/test_rule_wrappers.py);
// here, on top of them, every result is parsed.
// Run: node scripts/test-rare-xml-text-edits.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { normalizeBrexReferenceCode } from '../src/utils/ruleTestSkeleton.js';
import { unwrapRuleXml } from '../src/utils/ruleWrappers.js';

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) passes++;
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `\n   ${detail}` : ''}`);
  }
}
function parses(text) {
  const errors = [];
  new DOMParser({ errorHandler: (_l, msg) => errors.push(msg) }).parseFromString(`<root>${text}</root>`, 'text/xml');
  return errors.length === 0;
}
const attrsOf = (text, re) => {
  const m = re.exec(text);
  return m ? Object.fromEntries([...m[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [a[1], a[2] ?? a[3]])) : null;
};
const brexCode = (text) => attrsOf(text, /<brexDmRef>[\s\S]*?<dmCode\b([^>]*)\/?>/);

const own = (q = '"', extra = '') =>
  `<dmCode modelIdentCode=${q}ABC${q} systemDiffCode=${q}A${q} systemCode=${q}00${q} subSystemCode=${q}0${q} subSubSystemCode=${q}0${q} assyCode=${q}00${q} disassyCode=${q}00${q} disassyCodeVariant=${q}AB${q} infoCode=${q}040${q} infoCodeVariant=${q}A${q} itemLocationCode=${q}A${q}${extra}/>`;
const brex = (attrs = 'modelIdentCode="ABC" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="022" infoCodeVariant="A" itemLocationCode="D"') =>
  `<brexDmRef><dmRef><dmRefIdent><dmCode ${attrs}/></dmRefIdent></dmRef></brexDmRef>`;
const section = ({ ownCode = own(), before = '', status = '', brexRef = brex(), title = 'Example' } = {}) =>
  `<identAndStatusSection><dmAddress><dmIdent>${before}${ownCode}<language languageIsoCode="en" countryIsoCode="US"/><issueInfo issueNumber="001" inWork="00"/></dmIdent><dmAddressItems><issueDate year="2026" month="01" day="01"/><dmTitle><techName>${title}</techName></dmTitle></dmAddressItems></dmAddress><dmStatus issueType="new">${status}${brexRef}</dmStatus></identAndStatusSection>`;
const wanted = { modelIdentCode: 'ABC', systemDiffCode: 'A', systemCode: '00', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'AB', infoCode: '022', infoCodeVariant: 'A', itemLocationCode: 'D' };

// ── normalizeBrexReferenceCode ─────────────────────────────────────────
{
  const comment = '<!-- old code: <dmCode modelIdentCode="ZZZ" disassyCodeVariant="ZZ"/> and </dmIdent> -->';
  const input = section({ before: comment, status: comment });
  const r = normalizeBrexReferenceCode(input, 'identAndStatusSection');
  check('comment with a <dmCode> in it: brex code follows the real own code', JSON.stringify(brexCode(r.text)) === JSON.stringify(wanted), JSON.stringify(brexCode(r.text)));
  check('… both comments byte for byte', r.text.split(comment).length === 3);
  check('… valid XML', parses(r.text));
}
{
  const cdata = '<![CDATA[<dmCode modelIdentCode="ZZZ"/> </brexDmRef> & <]]>';
  const input = section({ status: `<remarks><simplePara>${cdata}</simplePara></remarks>`, title: `Title ${cdata}` });
  const r = normalizeBrexReferenceCode(input, 'identAndStatusSection');
  check('CDATA with markup: brex code follows the own code', JSON.stringify(brexCode(r.text)) === JSON.stringify(wanted), JSON.stringify(brexCode(r.text)));
  check('… CDATA byte for byte', r.text.split(cdata).length === 3);
  check('… valid XML', parses(r.text));
}
{
  const input = section({ ownCode: own("'") });
  const r = normalizeBrexReferenceCode(input, 'identAndStatusSection');
  check('single quotes: brex code follows', JSON.stringify(brexCode(r.text)) === JSON.stringify(wanted), JSON.stringify(brexCode(r.text)));
  check('… valid XML', parses(r.text));
}
{
  // The BREX code already has the right values, in another order and with
  // single quotes: nothing to change.
  const shuffled = Object.entries(wanted).reverse().map(([n, v]) => `${n}='${v}'`).join(' ');
  const input = section({ brexRef: brex(shuffled) });
  const r = normalizeBrexReferenceCode(input, 'identAndStatusSection');
  check('attributes in another order, same values: unchanged byte for byte', !r.changed && r.text === input);
}
{
  const input = section({ title: 'a &gt; b &amp; c', status: '<remarks><simplePara>x &lt; y</simplePara></remarks>' });
  const r = normalizeBrexReferenceCode(input, 'identAndStatusSection');
  check('entities in text stay as written', r.text.includes('a &gt; b &amp; c') && r.text.includes('x &lt; y') && parses(r.text));
}
for (const [name, input] of [
  ['brex dmCode never closed', section({ brexRef: '<brexDmRef><dmRef><dmRefIdent><dmCode modelIdentCode="ABC"></dmRefIdent></dmRef></brexDmRef>' })],
  ['own dmIdent never closed', section().replace('</dmIdent>', '')],
  ['truncated in the middle of a tag', section().slice(0, 200)],
  ['not XML at all', 'dmCode infoCode=040 < & >'],
]) {
  let r;
  try {
    r = normalizeBrexReferenceCode(input, 'identAndStatusSection');
  } catch (err) {
    check(`malformed (${name}): no exception`, false, err.message);
    continue;
  }
  check(`malformed (${name}): returned unchanged`, !r.changed && r.text === input);
}
{
  // 3.0.1 <avee>: a comment inside the DM's own avee, CDATA in the title.
  const avee = (v) => `<avee><modelic>ABC</modelic><sdc>A</sdc><chapnum>00</chapnum><section>0</section><subsect>0</subsect><subject>00</subject><discode>00</discode><discodev>${v}</discodev><incode>040</incode><incodev>A</incodev><itemloc>A</itemloc></avee>`;
  const ownAvee = avee('AB').replace('<sdc>', '<!-- sdc: see <x> --><sdc>');
  const input = `<idstatus><dmaddres><dmc>${ownAvee}</dmc><dmtitle><techname><![CDATA[a <b>]]></techname></dmtitle></dmaddres><status><brexref><refdm>${avee('A').replace('<incode>040', '<incode>022').replace('<itemloc>A', '<itemloc>D')}</refdm></brexref></status></idstatus>`;
  const r = normalizeBrexReferenceCode(input, 'idstatus');
  check('3.0.1: brex avee follows the own discodev', /<brexref><refdm><avee>[\s\S]*<discodev>AB<\/discodev>[\s\S]*<incode>022<\/incode>[\s\S]*<itemloc>D<\/itemloc>/.test(r.text), r.text);
  check('3.0.1: own avee comment and CDATA byte for byte, valid XML', r.text.includes('<!-- sdc: see <x> -->') && r.text.includes('<![CDATA[a <b>]]>') && parses(r.text));
}

// ── unwrapRuleXml: every shared case gives valid XML when its input is ──
const { cases } = JSON.parse(fs.readFileSync(new URL('../backend/tests/fixtures/rule_wrapper_cases.json', import.meta.url), 'utf8'));
for (const c of cases.filter((x) => x.name.startsWith('rare: ') || x.name.startsWith('malformed: '))) {
  const r = unwrapRuleXml(c.input, c.format);
  if (c.name.startsWith('rare: ')) {
    check(`${c.name}: valid in, valid out`, parses(c.input) && parses(r.xml) && r.changed);
    for (const kept of [...c.input.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g)].map((m) => m[0])) {
      check(`${c.name}: "${kept.slice(0, 30)}…" byte for byte`, r.xml.includes(kept));
    }
  } else {
    // (xmldom accepts a bare "&"; lxml, the backend twin, does not.)
    check(`${c.name}: returned as it was and flagged`, r.xml === c.input && r.malformed === true && Boolean(r.error));
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
