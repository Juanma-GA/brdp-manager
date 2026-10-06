// Ruta del esquema (rule test): where an element goes, and how to put it
// there validly, from one schema's structure (GET /api/schema-cards/
// structure: `elements` -- children and attribute names -- and `models` --
// each element's children in the XSD's order, the children a minimal valid
// instance needs, whether it holds text and its required attributes; see
// backend/app/services/rule_test_skeletons.py, schema_content_models).
//
// - simplePaths: the simple chains of elements from some sources down to an
//   element (shortest first, at most `limit`), over the schema's graph.
// - minimalNode / chainNode / renderNode: the minimal valid instance of an
//   element (its required children, recursively, and required attributes),
//   and the same for a chain of containers down to an element -- each
//   container with its required children and the next link in its place.
// - sectionRoutes (Part 1): for a rule that looks at the identification and
//   status section, the way from the minimal section to each element it
//   checks that is not directly inside one of the section's elements --
//   BRDP-S1-00065, //copyright: dmStatus/dataRestrictions/restrictionInfo/
//   copyright with the required restrictionInstructions/dataDistribution.
// - relocateMisplacedElements (Part 2): an element the LLM put where the
//   schema does not allow it ("<copyright> is not allowed inside
//   <dmStatus>") moved, without the LLM, down the ONLY valid way from that
//   parent, creating the missing containers and their required children.
//   Nothing is done when there is more than one way (the example goes to the
//   normal correction round).
// Pure: no DOM, no React -- importable from Node like src/prompts/.

// ─── Paths ──────────────────────────────────────────────────────────────────

// The simple chains [source, …, target] (at least one step, no element
// twice, a source never an intermediate step) from any of `sources` down to
// `target` over the schema's graph, shortest first, at most `limit` of them.
// "Only one way" means one simple chain of ANY length: the shortest alone is
// not enough -- <para> inside <para> has a single shortest way
// (para/footnote/para) and many longer ones (randomList/listItem/para, …),
// and moving it into a footnote would change what the example says.
// Depth-first, pruned by each element's distance to the target (only
// elements that can still reach it are entered), within a budget of steps;
// → { paths, complete } -- complete: false when the budget ran out, so a
// caller never takes one found way for the only one.
const PATH_SEARCH_BUDGET = 50000;
export function simplePaths(elements, sources, target, limit = 4) {
  const starts = [...new Set(sources)].filter((s) => elements[s]).sort();
  if (!elements[target] || starts.length === 0) return { paths: [], complete: true };
  // distance of every element to the target, over the parent links
  const parents = new Map();
  for (const [name, el] of Object.entries(elements)) {
    for (const child of el.children || []) {
      if (!parents.has(child)) parents.set(child, []);
      parents.get(child).push(name);
    }
  }
  const distTo = new Map([[target, 0]]);
  let frontier = [target];
  while (frontier.length) {
    const next = [];
    for (const name of frontier) {
      for (const parent of parents.get(name) || []) {
        if (!distTo.has(parent) && elements[parent]) {
          distTo.set(parent, distTo.get(name) + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  const startSet = new Set(starts);
  const found = [];
  let budget = PATH_SEARCH_BUDGET;
  let complete = true;
  const walk = (path, onPath) => {
    if (found.length >= limit) return;
    if (budget-- <= 0) {
      complete = false;
      return;
    }
    const node = path[path.length - 1];
    const children = [...new Set(elements[node]?.children || [])]
      .filter((c) => elements[c] && distTo.has(c))
      .sort((a, b) => distTo.get(a) - distTo.get(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const child of children) {
      if (found.length >= limit || !complete) return;
      if (child === target) {
        found.push([...path, child]);
        continue;
      }
      if (onPath.has(child) || startSet.has(child)) continue;
      onPath.add(child);
      path.push(child);
      walk(path, onPath);
      path.pop();
      onPath.delete(child);
    }
  };
  for (const start of starts.filter((s) => distTo.has(s))) {
    if (found.length >= limit || !complete) break;
    walk([start], new Set([start]));
  }
  found.sort((a, b) => a.length - b.length || (a.join('/') < b.join('/') ? -1 : 1));
  return { paths: found, complete: complete || found.length >= limit };
}

// ─── Minimal valid instances ────────────────────────────────────────────────

const MAX_BUILD_DEPTH = 12;

function nodeSize(node) {
  return 1 + node.children.reduce((sum, c) => sum + (c.raw != null ? 1 : nodeSize(c)), 0);
}

// { name, attributes: [[n, v]], text, children } -- the minimal valid
// instance of `name`: its required children (a required choice: the
// alternative with the smallest minimal instance, first on ties) and its
// required attributes. null when the model is missing or unresolved, a
// required attribute has no known value, or a required child cannot be built.
export function minimalNode(models, name, depth = 0, visiting = new Set()) {
  const model = models?.[name];
  if (!model || depth > MAX_BUILD_DEPTH || visiting.has(name)) return null;
  if ((model.attributes || []).some(([, value]) => value == null)) return null;
  const inner = new Set(visiting).add(name);
  const children = [];
  for (const slot of model.required || []) {
    const options = (Array.isArray(slot) ? slot : [slot])
      .map((n) => minimalNode(models, n, depth + 1, inner))
      .filter(Boolean);
    if (options.length === 0) return null;
    children.push(options.reduce((best, n) => (nodeSize(n) < nodeSize(best) ? n : best)));
  }
  return { name, attributes: (model.attributes || []).map(([n, v]) => [n, v]), text: Boolean(model.text) && children.length === 0, children };
}

// Where `child` goes among `siblings` (names) of `parent`: the index to insert
// it at, by the XSD's order of the parent's children.
function orderIndex(models, parent, child, siblings) {
  const order = models?.[parent]?.order || [];
  const at = order.indexOf(child);
  if (at < 0) return siblings.length;
  for (let i = 0; i < siblings.length; i += 1) {
    const other = order.indexOf(siblings[i]);
    if (other > at) return i;
  }
  return siblings.length;
}

// The chain path[0] → … → path[n-1] as one node: each container with its
// required children and the next link in its place (the required slot it
// fills, or its place in the XSD's order). `leaf` is the last link: a node,
// or { raw: text } to keep an element exactly as written. null when a
// container cannot be built.
export function chainNode(models, path, leaf) {
  if (path.length === 1) return leaf;
  const [name, ...rest] = path;
  const model = models?.[name];
  if (!model || (model.attributes || []).some(([, value]) => value == null)) return null;
  const next = chainNode(models, rest, leaf);
  if (!next) return null;
  const nextName = rest[0];
  const children = [];
  let placed = false;
  for (const slot of model.required || []) {
    const names = Array.isArray(slot) ? slot : [slot];
    if (!placed && names.includes(nextName)) {
      children.push(next);
      placed = true;
      continue;
    }
    const options = names.map((n) => minimalNode(models, n, 1, new Set([name]))).filter(Boolean);
    if (options.length === 0) return null;
    children.push(options.reduce((best, n) => (nodeSize(n) < nodeSize(best) ? n : best)));
  }
  if (!placed) {
    const at = orderIndex(models, name, nextName, children.map((c) => c.name));
    children.splice(at, 0, next);
  }
  return { name, attributes: (model.attributes || []).map(([n, v]) => [n, v]), text: false, children };
}

const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (v) => escText(v).replace(/"/g, '&quot;');

// A node as XML. `indent`: a string per level (lines), or null (one line).
// `placeholder`: the text of an element that holds text (the prompt's "…";
// "" builds an empty element).
export function renderNode(node, { indent = null, placeholder = '', level = 0 } = {}) {
  if (node.raw != null) return (indent != null ? indent.repeat(level) : '') + node.raw;
  const pad = indent != null ? indent.repeat(level) : '';
  const attrs = node.attributes.map(([n, v]) => ` ${n}="${escAttr(v)}"`).join('');
  if (node.children.length === 0) {
    return node.text && placeholder
      ? `${pad}<${node.name}${attrs}>${escText(placeholder)}</${node.name}>`
      : `${pad}<${node.name}${attrs}/>`;
  }
  const inner = node.children.map((c) => renderNode(c, { indent, placeholder, level: level + 1 }));
  if (indent == null) return `<${node.name}${attrs}>${inner.join('')}</${node.name}>`;
  return `${pad}<${node.name}${attrs}>\n${inner.join('\n')}\n${pad}</${node.name}>`;
}

// ─── Part 1: routes from the minimal identification and status section ──────

const SECTION_ROUTE_MAX_PATHS = 3;

function treeNodes(node, out = []) {
  out.push(node);
  for (const child of node.children || []) treeNodes(child, out);
  return out;
}

// [{ target, paths, position, minimal }] -- for each element the rule looks
// at in the section (`names`, in order) that is neither in the minimal
// section nor directly inside one of its elements: the ways (simple chains,
// shortest first) from
// the section to it (at most SECTION_ROUTE_MAX_PATHS; `names` of the rule's
// own path before it, `requiredSteps[target]`, keep only the ways through
// them when some are). With exactly one way: `position` -- where its first
// new container goes in the existing element ({ parent, container, after }
// or { parent, container, before } or { parent, container, first: true }) --
// and `minimal`, the chain from that container down to the element with
// every required child, as indented XML with "…" for text. A route whose
// way is part of another's is left out. [] when nothing is needed: the
// prompt does not change.
export function sectionRoutes(structure, section, names, requiredSteps = {}) {
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  if (!section?.tree) return [];
  const nodes = treeNodes(section.tree);
  const inSection = new Set(nodes.map((n) => n.name));
  const direct = new Set(nodes.flatMap((n) => elements[n.name]?.children || []));
  const routes = [];
  for (const target of [...new Set(names)]) {
    if (!elements[target] || inSection.has(target) || direct.has(target)) continue;
    const search = simplePaths(elements, [...inSection], target, SECTION_ROUTE_MAX_PATHS + 1);
    let paths = search.paths;
    if (paths.length === 0) continue;
    const through = (requiredSteps[target] || []).filter((s) => !inSection.has(s));
    if (through.length) {
      const consistent = paths.filter((p) => {
        let at = 0;
        for (const step of p) if (step === through[at]) at += 1;
        return at === through.length;
      });
      if (consistent.length) paths = consistent;
    }
    const single = paths.length === 1 && search.complete;
    const route = { target, paths: paths.slice(0, SECTION_ROUTE_MAX_PATHS), several: !single, position: null, minimal: null };
    if (single) {
      const [path] = paths;
      const parentNode = nodes.find((n) => n.name === path[0]);
      const existing = (parentNode?.children || []).map((c) => c.name);
      const order = models[path[0]]?.order || [];
      const at = order.indexOf(path[1]);
      const before = existing.filter((n) => order.indexOf(n) >= 0 && order.indexOf(n) < at);
      const after = existing.filter((n) => order.indexOf(n) > at);
      route.position =
        at < 0 || existing.length === 0
          ? { parent: path[0], container: path[1], first: true }
          : before.length
            ? { parent: path[0], container: path[1], after: before[before.length - 1] }
            : after.length
              ? { parent: path[0], container: path[1], before: after[0] }
              : { parent: path[0], container: path[1], first: true };
      const leaf = minimalNode(models, target) || { name: target, attributes: [], text: true, children: [] };
      const chain = chainNode(models, path.slice(1), leaf);
      route.minimal = chain ? renderNode(chain, { indent: '  ', placeholder: '…' }) : null;
    }
    routes.push(route);
  }
  // A way that is the beginning of another's says nothing more.
  const key = (p) => `${p.join('/')}/`;
  return routes.filter(
    (r) => !routes.some((o) => o !== r && r.paths.every((p) => o.paths.some((q) => key(q).startsWith(key(p)) && q.length > p.length)))
  );
}

// ─── Part 2: moving a misplaced element down the only valid way ─────────────

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

// The element tree of a fragment's text with the spans of each element
// ({ name, start, openEnd, closeStart, end, children }), under a virtual
// top node. null when the tags do not balance.
function parseSpans(text) {
  const top = { name: null, start: 0, openEnd: 0, closeStart: text.length, end: text.length, children: [] };
  const stack = [top];
  for (const m of text.matchAll(TAG_RE)) {
    if (m[2] === undefined) continue;
    const parent = stack[stack.length - 1];
    if (m[1]) {
      if (parent === top || parent.name !== m[2]) return null;
      parent.closeStart = m.index;
      parent.end = m.index + m[0].length;
      stack.pop();
    } else {
      const node = { name: m[2], start: m.index, openEnd: m.index + m[0].length, closeStart: null, end: null, children: [], selfClosing: Boolean(m[4]) };
      parent.children.push(node);
      if (m[4]) {
        node.closeStart = node.start;
        node.end = node.openEnd;
      } else {
        stack.push(node);
      }
    }
  }
  return stack.length === 1 ? top : null;
}

function findMisplaced(node, parentName, elements, skip) {
  for (const child of node.children) {
    const name = child.name;
    if (
      parentName &&
      elements[name] &&
      elements[parentName] &&
      !elements[parentName].children.includes(name) &&
      !skip.has(`${parentName}>${name}@${child.start}`)
    ) {
      return { node: child, parent: node, parentName };
    }
    const deeper = findMisplaced(child, name, elements, skip);
    if (deeper) return deeper;
  }
  return null;
}

// Moves, in the TEXT of `text` (a fragment of top-level elements that go
// inside `parentName`; null when its top level is the document root), every
// element the schema does not allow in its parent down the only valid way
// from that parent (simplePaths: exactly one simple chain). Existing
// containers on the way are reused (the first child of that name); the
// missing ones are created with their required children (chainNode) and
// placed by the XSD's order. Nothing is changed for an element with no way
// or more than one, or a way whose containers cannot be built. The moved
// element keeps its text exactly; the new containers are written on one line.
// → { text, moved: [{ element, parent, path }] }.
export function relocateMisplacedElements(text, structure, parentName) {
  const original = String(text ?? '');
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  if (!structure?.models || !Object.keys(models).length) return { text: original, moved: [] };
  let current = original;
  const moved = [];
  const skip = new Set();
  for (let pass = 0; pass < 20; pass += 1) {
    const top = parseSpans(current);
    if (!top) return { text: original, moved: [] };
    const found = findMisplaced(top, parentName, elements, skip);
    if (!found) break;
    const { node, parent, parentName: pName } = found;
    const { paths, complete } = simplePaths(elements, [pName], node.name, 2);
    if (paths.length !== 1 || !complete) {
      skip.add(`${pName}>${node.name}@${node.start}`);
      continue;
    }
    const path = paths[0];
    // Reuse existing containers on the way.
    let into = parent;
    let intoName = pName;
    let i = 1;
    while (i < path.length - 1) {
      const existing = into.children.find((c) => c !== node && c.name === path[i]);
      if (!existing || existing.selfClosing) break;
      into = existing;
      intoName = path[i];
      i += 1;
    }
    const raw = current.slice(node.start, node.end);
    const chain = chainNode(models, path.slice(i), { raw });
    if (!chain) {
      skip.add(`${pName}>${node.name}@${node.start}`);
      continue;
    }
    const insertText = renderNode(chain);
    const firstName = path[i];
    const siblings = into.children.filter((c) => c !== node);
    const at = orderIndex(models, intoName, firstName, siblings.map((c) => c.name));
    const insertAt = at < siblings.length ? siblings[at].start : at > 0 ? siblings[at - 1].end : into.openEnd;
    // Remove first when it comes after the insertion point, else insert first.
    const removeStart = node.start;
    const removeEnd = node.end;
    if (insertAt <= removeStart) {
      current = current.slice(0, insertAt) + insertText + current.slice(insertAt, removeStart) + current.slice(removeEnd);
    } else {
      current = current.slice(0, removeStart) + current.slice(removeEnd, insertAt) + insertText + current.slice(insertAt);
    }
    moved.push({ element: node.name, parent: pName, path });
  }
  return { text: current, moved };
}

// ─── Mejoras C, Part 2: where an element of the rule goes ───────────────────

const PLACE_MAX_PARENTS = 5;

function shortestWay(elements, root, target) {
  if (!elements[root] || !elements[target]) return null;
  const previous = new Map([[root, null]]);
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const name of [...frontier].sort()) {
      for (const child of [...(elements[name]?.children || [])].sort()) {
        if (previous.has(child)) continue;
        previous.set(child, name);
        if (child === target) {
          const way = [child];
          for (let n = name; n; n = previous.get(n)) way.unshift(n);
          return way;
        }
        next.push(child);
      }
    }
    frontier = next;
  }
  return null;
}

// [{ element, parents, way, after, before }] -- for each element the rule
// names (`names`) that does not fit directly where the LLM writes (the
// insertion point's children; for a whole document, the root's), is not
// already in the skeleton or the minimal identification and status section,
// and is not `skip`ped (a route or nesting the prompt already gives): the
// elements it can be a child of in this schema. With ONE parent: `way`, the
// shortest chain from the root down to it ("dmodule/idstatus/status"), and,
// when that parent is in the minimal section, its neighbours there by the
// XSD's order ("after <orig>, before <applic>"). Several parents (at most
// PLACE_MAX_PARENTS, else nothing -- a list that long tells the LLM
// nothing): `parents` only. Real case BRDP-EXT-02613 (3.0.1,
// /dmodule[not(//actref)]): the LLM put <actref> in <descript>; it only goes
// in <status> (or <pmstatus>, another schema).
export function elementPlaces(structure, placement, names, skip = []) {
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  if (!placement?.root || !elements[placement.root]) return [];
  const sectionNodes = placement.metadata?.tree ? treeNodes(placement.metadata.tree) : [];
  const present = new Set([...(placement.path || []), ...sectionNodes.map((n) => n.name), placement.root]);
  const fitsAt = placement.insertion && placement.contentInsertion !== false ? placement.insertion : placement.insertion ? null : placement.root;
  const fits = new Set(fitsAt ? elements[fitsAt]?.children || [] : []);
  const skipped = new Set(skip);
  const out = [];
  for (const name of [...new Set(names)]) {
    if (!elements[name] || present.has(name) || fits.has(name) || skipped.has(name)) continue;
    const parents = Object.keys(elements).filter((p) => (elements[p].children || []).includes(name)).sort();
    if (parents.length === 0 || parents.length > PLACE_MAX_PARENTS) continue;
    const place = { element: name, parents, way: null, after: null, before: null };
    if (parents.length === 1) {
      const way = shortestWay(elements, placement.root, parents[0]);
      place.way = way ? way.join('/') : null;
      const node = sectionNodes.find((n) => n.name === parents[0]);
      if (node) {
        const order = models[parents[0]]?.order || [];
        const at = order.indexOf(name);
        const siblings = (node.children || []).map((c) => c.name).filter((n) => order.indexOf(n) >= 0);
        if (at >= 0) {
          place.after = [...siblings].reverse().find((n) => order.indexOf(n) < at) || null;
          place.before = siblings.find((n) => order.indexOf(n) > at) || null;
        }
      }
    }
    out.push(place);
  }
  return out;
}

// "<actref> goes inside <status> (dmodule/idstatus/status), after <orig> and
// before <applic>." -- the same sentence for the prompt and the correction.
export function placeSentence(place) {
  if (place.parents.length > 1) {
    const list = place.parents.map((p) => `<${p}>`);
    return `<${place.element}> goes inside ${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}.`;
  }
  const where = place.way ? ` (${place.way})` : '';
  const between =
    place.after && place.before
      ? `, after <${place.after}> and before <${place.before}>`
      : place.after
        ? `, after <${place.after}>`
        : place.before
          ? `, before <${place.before}>`
          : '';
  return `<${place.element}> goes inside <${place.parents[0]}>${where}${between}.`;
}

// Moves, in `text`, an element the rule names (`names`) that sits where the
// schema does not allow it, into its ONLY possible parent in this schema
// when exactly one such parent is already in the text -- at its place by the
// XSD's order. `keepsResult(before, after)` decides whether the move would
// change what the rule selects or decides (then nothing moves: the example
// goes to the correction round with the place). Nothing either with several
// possible parents, or several (or no) instances of the parent.
// → { text, moved: [{ element, parent, path }] }
export function relocateToOnlyParent(text, structure, parentName, names, keepsResult = () => true) {
  const original = String(text ?? '');
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  const wanted = new Set(names || []);
  if (!wanted.size || !Object.keys(elements).length) return { text: original, moved: [] };
  let current = original;
  const moved = [];
  const skip = new Set();
  for (let pass = 0; pass < 20; pass += 1) {
    const top = parseSpans(current);
    if (!top) return { text: original, moved: [] };
    let found = null;
    const visit = (node, name) => {
      for (const child of node.children) {
        if (found) return;
        if (
          name &&
          wanted.has(child.name) &&
          elements[child.name] &&
          elements[name] &&
          !elements[name].children.includes(child.name) &&
          !skip.has(`${name}>${child.name}@${child.start}`)
        ) {
          found = { node: child, parentName: name };
          return;
        }
        visit(child, child.name);
      }
    };
    visit(top, parentName);
    if (!found) break;
    const { node, parentName: wrong } = found;
    const key = `${wrong}>${node.name}@${node.start}`;
    const parents = Object.keys(elements).filter((p) => (elements[p].children || []).includes(node.name));
    const targets = parents.length === 1 ? treeNodes(top).filter((n) => n.name === parents[0] && !n.selfClosing && n !== top) : [];
    if (targets.length !== 1) {
      skip.add(key);
      continue;
    }
    const into = targets[0];
    const raw = current.slice(node.start, node.end);
    const siblings = into.children;
    const at = orderIndex(models, into.name, node.name, siblings.map((c) => c.name));
    const insertAt = at < siblings.length ? siblings[at].start : at > 0 ? siblings[at - 1].end : into.openEnd;
    const next =
      insertAt <= node.start
        ? current.slice(0, insertAt) + raw + current.slice(insertAt, node.start) + current.slice(node.end)
        : current.slice(0, node.start) + current.slice(node.end, insertAt) + raw + current.slice(insertAt);
    if (!keepsResult(current, next)) {
      skip.add(key);
      continue;
    }
    current = next;
    const chain = [];
    const find = (n, trail) => {
      if (n === into) return chain.push(...trail, n.name), true;
      return n.children.some((c) => find(c, n.name ? [...trail, n.name] : trail));
    };
    find(top, parentName ? [parentName] : []);
    moved.push({ element: node.name, parent: wrong, path: [...chain, node.name], onlyParent: true });
  }
  return { text: current, moved };
}
