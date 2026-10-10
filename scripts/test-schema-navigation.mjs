// "Nombres navegables en las respuestas de Ask sin IA": the pure logic of
// the floating schema card (src/utils/schemaNavigation.js) -- which names in
// an answer taken from the schema become links, the breadcrumb/Back stack,
// the card cache (no card asked for twice; reset drops late answers; an
// error never leaves the card loading), the "+N more" list cutting and the
// element/attribute card models, with the real schema cards of
// scripts/rule-test-fixtures/structural-answers.json and the real
// vocabularies. Plain Node, no server.
import fs from 'node:fs';
import { answerStructuralQuestion } from '../src/utils/structuralAnswer.js';
import {
  attributeCardModel,
  backStack,
  createCardStore,
  crumbLabel,
  currentTarget,
  cutNames,
  elementCardModel,
  goToStack,
  moreMarker,
  openStack,
  parseMoreMarker,
  pushStack,
  schemaLinkTarget,
  schemaSuggestions,
  SCHEMA_NAV_LIST_MAX,
  SCHEMA_SEARCH_MAX,
  targetLabel,
} from '../src/utils/schemaNavigation.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const V42 = vocabOf('schema-vocabulary-4-2.json');
const VDITA = vocabOf('schema-vocabulary-dita.json');
const FIX = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structural-answers.json', import.meta.url)));
const S42 = 'S1000D 4.2';
const SDITA = 'DITA 1.3 Xpath2.0';

let calls = [];
const fetchCards = async (std, names, opts) => {
  calls.push(['cards', std, names.join(','), !!opts?.full]);
  const all = FIX.cards[std] || {};
  return { available: true, cards: Object.fromEntries(names.filter((n) => all[n]).map((n) => [n, all[n]])) };
};
const fetchAttribute = async (std, name) => {
  calls.push(['attribute', std, name]);
  return { available: true, owners: FIX.attributes[std]?.[name] || [] };
};
const fetchRelation = async (std, parent, child) => FIX.relations[std][`${parent}/${child}`];

// The inline code spans of a Markdown answer, as ReactMarkdown hands them
// to the `code` renderer.
const codeSpans = (markdown) => [...markdown.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const linksOf = (markdown, vocabulary) =>
  codeSpans(markdown)
    .map((c) => schemaLinkTarget(c, vocabulary))
    .filter(Boolean)
    .map(targetLabel);

// ─── Which names become links ───────────────────────────────────────────────
{
  check('<para> is an element link', JSON.stringify(schemaLinkTarget('<para>', V42)) === '{"kind":"element","name":"para"}');
  check('@emphasisType is an attribute link', JSON.stringify(schemaLinkTarget('@emphasisType', V42)) === '{"kind":"attribute","name":"emphasisType"}');
  check('a name not in the schema is plain text', schemaLinkTarget('<pokemon>', V42) === null && schemaLinkTarget('@pokemon', V42) === null);
  check('an attribute written as an element is plain text', schemaLinkTarget('<emphasisType>', V42) === null);
  check('an element written as an attribute is plain text', schemaLinkTarget('@para', V42) === null);
  // 'title' is both an element and an attribute in 4.2: it opens the kind it is written as.
  check('both-kind name opens as element when written <title>', schemaLinkTarget('<title>', V42)?.kind === 'element');
  check('both-kind name opens as attribute when written @title', schemaLinkTarget('@title', V42)?.kind === 'attribute');
  check('bare name / values / free text are not links', ['para', 'em01', 'cv01–cv99', '<para> x', '</para>', '<a/b>', '@'].every((c) => schemaLinkTarget(c, V42) === null));
  check('whitespace around the code is tolerated', schemaLinkTarget(' <para> ', V42)?.name === 'para');
  check('no vocabulary: no links', schemaLinkTarget('<para>', null) === null);
  check('DITA <p> and @outputclass are links', schemaLinkTarget('<p>', VDITA)?.kind === 'element' && schemaLinkTarget('@outputclass', VDITA)?.kind === 'attribute');
}

// Links in real answers taken from the schema.
{
  const parents = await answerStructuralQuestion({ question: '¿Dónde puede ir <para>?', standard: S42, vocabulary: V42, fetchCards, fetchAttribute, fetchRelation });
  const links = linksOf(parents.text, V42);
  check('"¿Dónde puede ir <para>?" links <para> and all its 43 parents', links.includes('<para>') && links.includes('<levelledPara>') && new Set(links).size === 44, `${new Set(links).size} links`);
  const owners = await answerStructuralQuestion({ question: '¿Qué elementos tienen @emphasisType?', standard: S42, vocabulary: V42, fetchCards, fetchAttribute, fetchRelation });
  check('attribute owners answer links @emphasisType and <emphasis>', ['@emphasisType', '<emphasis>'].every((l) => linksOf(owners.text, V42).includes(l)));
  const values = await answerStructuralQuestion({ question: '¿Qué valores tiene @emphasisType?', standard: S42, vocabulary: V42, fetchCards, fetchAttribute, fetchRelation });
  check('values are not links', !linksOf(values.text, V42).some((l) => /em0/.test(l)) && /em01/.test(values.text));
  const unknown = await answerStructuralQuestion({ question: '¿Qué puede contener <pokemon>?', standard: S42, vocabulary: V42, fetchCards, fetchAttribute, fetchRelation });
  check('"<pokemon> does not exist" has no link', linksOf(unknown.text, V42).length === 0 && /pokemon/.test(unknown.text));
  const wrongKind = await answerStructuralQuestion({ question: '¿Qué valores tiene @table?', standard: S42, vocabulary: V42, fetchCards, fetchAttribute, fetchRelation });
  check('"@table is an element" links only <table>', JSON.stringify(linksOf(wrongKind.text, V42)) === '["<table>"]', wrongKind.text);
  const dita = await answerStructuralQuestion({ question: 'What attributes does <p> take?', standard: SDITA, vocabulary: VDITA, fetchCards, fetchAttribute, fetchRelation });
  check('DITA answer links <p> and @outputclass', ['<p>', '@outputclass'].every((l) => linksOf(dita.text, VDITA).includes(l)));
}

// ─── Navigation stack ───────────────────────────────────────────────────────
{
  const para = { kind: 'element', name: 'para' };
  const lp = { kind: 'element', name: 'levelledPara' };
  const title = { kind: 'element', name: 'title' };
  const attr = { kind: 'attribute', name: 'emphasisType' };
  let s = openStack(para);
  s = pushStack(s, lp);
  s = pushStack(s, title);
  check('breadcrumb para › levelledPara › title', s.map(crumbLabel).join(' › ') === 'para › levelledPara › title');
  check('current card is the last one', currentTarget(s).name === 'title');
  s = backStack(s);
  check('Back goes one step', s.map(crumbLabel).join(' › ') === 'para › levelledPara');
  check('Back on the first card stays', backStack(openStack(para)).length === 1);
  check('the card on screen again is a no-op', pushStack(s, lp).length === 2);
  check('a name already in the path goes back to it', pushStack([para, lp, title], para).length === 1);
  check('same name, other kind, is a new step', pushStack([title], { kind: 'attribute', name: 'title' }).length === 2);
  check('attribute crumb keeps its @', crumbLabel(attr) === '@emphasisType');
  check('breadcrumb click goes back to that entry', goToStack([para, lp, title], 0).length === 1 && goToStack([para, lp], 9).length === 2);
  check('labels: <x> and @y', targetLabel(para) === '<para>' && targetLabel(attr) === '@emphasisType');
  check('empty stack has no current card', currentTarget([]) === null);
}

// ─── List cutting ───────────────────────────────────────────────────────────
{
  const names = Array.from({ length: 43 }, (_, i) => `n${String(i).padStart(2, '0')}`).reverse();
  const cut = cutNames(names);
  check('43 names: 20 shown, +23', cut.shown.length === SCHEMA_NAV_LIST_MAX && cut.hidden === 23);
  check('shown names are sorted', cut.shown[0] === 'n00' && cut.shown[19] === 'n19');
  const all = cutNames(names, { expanded: true });
  check('expanded: every name, none lost', all.shown.length === 43 && all.hidden === 0);
  check('20 or fewer: no cut', cutNames(names.slice(0, 20)).hidden === 0);
  check('duplicates count once', cutNames(['a', 'b', 'a']).shown.length === 2);
}

// ─── Card models ────────────────────────────────────────────────────────────
{
  const para = elementCardModel(FIX.cards[S42].para);
  check('<para>: 8 variants summarized, 28 schemas', para.multiVariant && para.schemaCount === 28);
  check('<para>: 43 parents', para.parents.length === 43);
  check('<para>: children common to all + "also in" groups', para.children.mode === 'common' && para.children.common.length > 0 && para.children.groups.some((g) => g.items.includes('footnote')));
  check('<para>: attributes common to all', para.attributes.mode === 'common' && para.attributes.common.some((a) => a.name === 'changeMark'));
  const ident = elementCardModel(FIX.cards[S42].identAndStatusSection);
  check('<identAndStatusSection>: children by schema, parents never as children',
    ident.children.mode === 'bySchema' && ident.children.groups.every((g) => !g.items.includes('dmodule')) && ident.children.groups.some((g) => g.items.includes('dmAddress')));
  const table = elementCardModel(FIX.cards[S42].table);
  check('<table>: @frame with its closed list of values', (table.attributes.common.length ? table.attributes.common : table.attributes.groups.flatMap((g) => g.items)).some((a) => a.name === 'frame' && a.enum?.includes('topbot')));
  const p = elementCardModel(FIX.cards[SDITA].p);
  check('DITA <p>: single variant with its schemas', !p.multiVariant && p.schemas.length > 0 && p.attributes.mode === 'single' && p.attributes.common.some((a) => a.name === 'outputclass'));
  const root = elementCardModel(FIX.cards[S42].dmodule);
  check('<dmodule>: no parents', root.parents.length === 0);

  const changeMark = attributeCardModel(FIX.attributes[S42].changeMark);
  const ownerCount = new Set(FIX.attributes[S42].changeMark.map((o) => o.element)).size;
  const listed = new Set([...changeMark.owners.common, ...changeMark.owners.groups.flatMap((g) => g.items)]);
  check('@changeMark: 672 owners, every one listed', ownerCount === 672 && listed.size === 672, `${ownerCount} / ${listed.size}`);
  check('@changeMark: grouped by schema', ['common', 'bySchema'].includes(changeMark.owners.mode));
  const emph = attributeCardModel(FIX.attributes[S42].emphasisType);
  check('@emphasisType: values em01–em99 on <emphasis>', emph.values.length === 1 && emph.values[0].values.join(',').includes('em01') && emph.values[0].elements.includes('emphasis'));
  check('@emphasisType: one owner, same everywhere', emph.owners.mode === 'same' && JSON.stringify(emph.owners.common) === '["emphasis"]');
  const oc = attributeCardModel(FIX.attributes[SDITA].outputclass);
  check('DITA @outputclass: free values, owners listed', oc.exists && oc.values.every((g) => g.values === null) && oc.owners.common.includes('p'));
  check('an attribute with no owners does not exist', attributeCardModel([]).exists === false);
}

// ─── Card cache ─────────────────────────────────────────────────────────────
{
  let changes = 0;
  const store = createCardStore({ standard: S42, fetchCards, fetchAttribute, onChange: () => (changes += 1) });
  calls = [];
  const para = { kind: 'element', name: 'para' };
  const lp = { kind: 'element', name: 'levelledPara' };
  const attr = { kind: 'attribute', name: 'emphasisType' };
  await store.load(para);
  check('element card asks for the full card of that name', JSON.stringify(calls) === JSON.stringify([['cards', S42, 'para', true]]));
  check('element card ready', store.get(para).status === 'ready' && store.get(para).data.entry === FIX.cards[S42].para);
  await store.load(lp);
  check('a name without a card is shown as missing, never loading', store.get(lp).status === 'ready' && store.get(lp).data.missing === true);
  await store.load(para);
  await store.load(para);
  check('a loaded card is never asked for again (Back / coming back)', calls.filter((c) => c[2] === 'para').length === 1);
  await store.load(attr);
  check('attribute card asks for its owners', calls.some((c) => c[0] === 'attribute' && c[2] === 'emphasisType') && store.get(attr).data.owners.length > 0);
  check('onChange fires on every change', changes >= 6);
  store.reset();
  check('reset empties the cache', store.get(para) === null);
  calls = [];
  await store.load(para);
  check('after reset the card is asked for again', calls.length === 1);

  // A load still on its way when the BRDP changes is dropped.
  let release;
  const slowStore = createCardStore({
    standard: S42,
    fetchCards: () => new Promise((r) => (release = r)),
    fetchAttribute,
  });
  const pending = slowStore.load(para);
  check('a card being loaded shows as loading', slowStore.get(para).status === 'loading');
  slowStore.reset();
  release({ available: true, cards: { para: FIX.cards[S42].para } });
  await pending;
  check('a late answer after reset is dropped', slowStore.get(para) === null);

  // Errors: visible, never loading forever, asked for again on Retry.
  let fail = true;
  const errStore = createCardStore({
    standard: S42,
    fetchCards: async () => {
      if (fail) throw new Error('HTTP 500');
      return { available: true, cards: { para: FIX.cards[S42].para } };
    },
    fetchAttribute,
  });
  await errStore.load(para);
  check('a failed load is an error with its message', errStore.get(para).status === 'error' && errStore.get(para).error === 'HTTP 500');
  fail = false;
  await errStore.load(para, { force: true });
  check('Retry asks again and shows the card', errStore.get(para).status === 'ready');
  const hangStore = createCardStore({ standard: S42, fetchCards: () => new Promise(() => {}), fetchAttribute, timeoutMs: 30 });
  await hangStore.load(para);
  check('a request that never answers becomes an error (timeout)', hangStore.get(para).status === 'error' && hangStore.get(para).error === 'timeout');
  const noCards = createCardStore({ standard: 'S1000D 5.0', fetchCards: async () => ({ available: false }), fetchAttribute: async () => ({ available: false }) });
  await noCards.load(para);
  await noCards.load(attr);
  check('standard without cards: unavailable, not loading', noCards.get(para).status === 'unavailable' && noCards.get(attr).status === 'unavailable');
}

// ─── "+N more" in the answers ───────────────────────────────────────────────
{
  check('marker round trip', parseMoreMarker(moreMarker(3)) === 3 && parseMoreMarker(' +more:0 ') === 0);
  check('other code is not a marker', ['<para>', '@x', '+more:', '+more:a', 'more:1', '+23 more'].every((c) => parseMoreMarker(c) === null));
  check('a marker is never a schema link', schemaLinkTarget(moreMarker(0), V42) === null);

  const r = await answerStructuralQuestion({ question: '¿Qué elementos tienen @changeMark?', standard: S42, vocabulary: V42, fetchCards, fetchAttribute, fetchRelation });
  const allOwners = new Set(FIX.attributes[S42].changeMark.map((o) => o.element));
  check('@changeMark: turn text keeps the plain "+N más"', /\+\d+ más/.test(r.text) && parseMoreMarker(r.text) === null && !r.text.includes('+more:'));
  check('@changeMark: several cut lists (common and "Además, en…")', r.cuts.length > 1, `${r.cuts.length} cuts`);
  check('@changeMark: display has one marker per cut, no plain "+N más"', r.cuts.every((c) => r.display.includes(`\`${moreMarker(c.id)}\``)) && !/\+\d+ más/.test(r.display));
  check('no two code spans touch (Markdown would read a double backtick)', !r.display.includes('``') && r.cuts.every((c) => r.display.includes(`\u2060\`${moreMarker(c.id)}\``)));
  check('each cut has its own id', new Set(r.cuts.map((c) => c.id)).size === r.cuts.length && r.cuts.every((c, i) => c.id === i));
  // Every owner appears in the display, shown or hidden: none is lost.
  const shownInDisplay = new Set([...r.display.matchAll(/`<([^`>]+)>`/g)].map((m) => m[1]));
  const hidden = new Set(r.cuts.flatMap((c) => c.hidden));
  const union = new Set([...shownInDisplay, ...hidden]);
  check('@changeMark: shown + hidden = all 672 owners', [...allOwners].every((n) => union.has(n)) && allOwners.size === 672, `${[...allOwners].filter((n) => !union.has(n)).length} missing`);
  check('hidden names are elements, sorted, as the card cuts them', r.cuts.every((c) => c.kind === 'element' && c.hidden.join() === [...c.hidden].sort((a, b) => a.localeCompare(b)).join()));
  // The turn text's "+N" numbers are the hidden counts.
  const plusNumbers = [...r.text.matchAll(/\+(\d+) más/g)].map((m) => Number(m[1]));
  check('turn text "+N" = hidden count of each cut', JSON.stringify(plusNumbers) === JSON.stringify(r.cuts.map((c) => c.hidden.length)));
  // Each cut list shows exactly SCHEMA_NAV_LIST_MAX names before its marker (same cut as the card).
  const firstLine = r.display.split('\n').find((l) => l.includes(moreMarker(0)));
  const before = firstLine.slice(0, firstLine.indexOf(moreMarker(0)));
  check('a cut list shows 20 names before its "+N more"', [...before.matchAll(/`<[^`>]+>`/g)].length === SCHEMA_NAV_LIST_MAX, firstLine.slice(0, 80));

  const short = await answerStructuralQuestion({ question: '¿Qué elementos tienen @emphasisType?', standard: S42, vocabulary: V42, fetchCards, fetchAttribute, fetchRelation });
  check('no cut list: display = text, no cuts', short.cuts.length === 0 && short.display === short.text);
  const para = await answerStructuralQuestion({ question: '¿Dónde puede ir <para>?', standard: S42, vocabulary: V42, fetchCards, fetchAttribute, fetchRelation });
  check('letter-grouped lists are never cut', para.cuts.length === 0 && para.display === para.text);
}

// ─── Schema search suggestions ──────────────────────────────────────────────
{
  const names = (r) => r.items.map((i) => (i.kind === 'attribute' ? `@${i.name}` : `<${i.name}>`));
  const levell = schemaSuggestions('levell', V42);
  check('prefix "levell" → <levelledPara> first', names(levell)[0] === '<levelledPara>' && levell.items.every((i) => i.name.toLowerCase().startsWith('levell')));
  check('case-insensitive prefix', JSON.stringify(names(schemaSuggestions('LEVELL', V42))) === JSON.stringify(names(levell)));
  check('"@emph" → @emphasisType, attributes only', names(schemaSuggestions('@emph', V42)).includes('@emphasisType') && schemaSuggestions('@emph', V42).items.every((i) => i.kind === 'attribute'));
  check('"<emph" → elements only', schemaSuggestions('<emph', V42).items.every((i) => i.kind === 'element') && names(schemaSuggestions('<emph', V42))[0] === '<emphasis>');
  check('"<levelledPara>" (closing >) still matches', names(schemaSuggestions('<levelledPara>', V42))[0] === '<levelledPara>');
  const title = names(schemaSuggestions('title', V42));
  check('"title" (element and attribute) → <title> and @title first', title[0] === '<title>' && title[1] === '@title', title.slice(0, 3).join());
  const many = schemaSuggestions('a', V42);
  check('at most 10 suggestions', SCHEMA_SEARCH_MAX === 10 && many.items.length === 10 && !many.noMatch);
  const poke = schemaSuggestions('pokemon', V42);
  check('"pokemon" → no suggestions, noMatch', poke.items.length === 0 && poke.noMatch === true);
  check('"@para" gives only attributes (@parameter…), never <para>', schemaSuggestions('@para', V42).items.every((i) => i.kind === 'attribute' && i.name.startsWith('para')));
  check('"<levelledPara" never gives attributes', schemaSuggestions('<levelledPara', V42).items.every((i) => i.kind === 'element'));
  check('empty / "@" / "<" / spaces → nothing, no message', ['', '@', '<', '   '].every((q) => { const r = schemaSuggestions(q, V42); return r.items.length === 0 && !r.noMatch; }));
  check('no vocabulary → nothing', schemaSuggestions('para', null).items.length === 0 && !schemaSuggestions('para', null).noMatch);
  check('DITA: "p" includes <p>, "@outputc" → @outputclass', names(schemaSuggestions('p', VDITA))[0] === '<p>' && names(schemaSuggestions('@outputc', VDITA))[0] === '@outputclass');
  check('an exact name comes before longer ones', names(schemaSuggestions('para', V42))[0] === '<para>');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
