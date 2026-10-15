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

// The distance of every element down to `target`, over the parent links.
function distancesTo(elements, target) {
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
  return distTo;
}

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
  const distTo = distancesTo(elements, target);
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

// The simple chains from any of `sources` that follow the rule's own steps
// (`segments`, [{ name, axis }] in order, the last one the target): a
// 'child' segment is the very next element of the chain, a 'descendant' one
// (or 'other') is anywhere further down. "dmStatus//para/captionGroup" from
// <dmStatus> → only chains through a <para> whose next element is the
// <captionGroup>. Same rules as simplePaths (no element twice, a source
// never an intermediate step). Iterative deepening on the chain's length,
// so the chains come shortest first and the first `limit` found are the
// shortest ones; within a budget of steps (complete: false when it ran out).
const STEP_PATH_MAX_LENGTH = 24;
export function stepPaths(elements, sources, segments, limit = 4) {
  const target = segments[segments.length - 1]?.name;
  const starts = [...new Set(sources)].filter((s) => elements[s]).sort();
  if (!target || !elements[target] || starts.length === 0) return { paths: [], complete: true };
  const distTo = distancesTo(elements, target);
  const startSet = new Set(starts);
  const found = [];
  const seen = new Set();
  let budget = PATH_SEARCH_BUDGET;
  let complete = true;
  let maxLength = 0;
  const walk = (path, onPath, at) => {
    if (budget-- <= 0) {
      complete = false;
      return;
    }
    const seg = segments[at];
    const node = path[path.length - 1];
    const children = [...new Set(elements[node]?.children || [])]
      .filter((c) => elements[c] && distTo.has(c) && path.length + 1 + distTo.get(c) <= maxLength)
      .sort((a, b) => distTo.get(a) - distTo.get(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const child of children) {
      if (!complete) return;
      if (onPath.has(child)) continue;
      if (child === seg.name) {
        if (at === segments.length - 1) {
          const key = [...path, child].join('/');
          if (!seen.has(key) && path.length + 1 === maxLength) {
            seen.add(key);
            found.push([...path, child]);
          }
        } else if (!startSet.has(child)) {
          onPath.add(child);
          path.push(child);
          walk(path, onPath, at + 1);
          path.pop();
          onPath.delete(child);
        }
      }
      if (seg.axis === 'child' || child === target || startSet.has(child)) continue;
      onPath.add(child);
      path.push(child);
      walk(path, onPath, at);
      path.pop();
      onPath.delete(child);
    }
  };
  const reachable = starts.filter((s) => distTo.has(s));
  const shortest = Math.min(...reachable.map((s) => distTo.get(s) + 1));
  for (maxLength = shortest; maxLength <= STEP_PATH_MAX_LENGTH && found.length < limit && complete; maxLength += 1) {
    for (const start of reachable) {
      if (!complete) break;
      walk([start], new Set([start]), 0);
    }
  }
  found.sort((a, b) => a.length - b.length || (a.join('/') < b.join('/') ? -1 : 1));
  return { paths: found.slice(0, limit), complete: complete || found.length >= limit };
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
// shortest first) from the section to it, at most SECTION_ROUTE_MAX_PATHS.
// `requirements[target]` = { segments, after }: the rule's own steps after
// the last one the minimal section already has (`after`, or null), each
// with its axis -- only the ways that follow them (stepPaths), searched
// before cutting (EXT-00188, //dmodule/identAndStatusSection/dmStatus//para/
// captionGroup: 21 ways reach a <captionGroup> right inside a <para>; the
// first four ways to any <captionGroup> went through none). Starting at
// `after` (or below it, for a "//" step) when it is a section element. When
// no way follows them, every way as before. With exactly one way: `position` -- where its first
// new container goes in the existing element ({ parent, container, after }
// or { parent, container, before } or { parent, container, first: true }) --
// and `minimal`, the chain from that container down to the element with
// every required child, as indented XML with "…" for text. A route whose
// way is part of another's is left out. [] when nothing is needed: the
// prompt does not change.
export function sectionRoutes(structure, section, names, requirements = {}) {
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  if (!section?.tree) return [];
  const nodes = treeNodes(section.tree);
  const inSection = new Set(nodes.map((n) => n.name));
  const direct = new Set(nodes.flatMap((n) => elements[n.name]?.children || []));
  const routes = [];
  for (const target of [...new Set(names)]) {
    if (!elements[target] || inSection.has(target) || direct.has(target)) continue;
    let search = null;
    const req = requirements[target];
    if (req?.segments?.length) {
      const from = req.after ? nodes.filter((n) => n.name === req.after) : [];
      const starts = from.length
        ? [...new Set(from.flatMap((n) => (req.segments[0].axis === 'child' ? [n] : treeNodes(n))).map((n) => n.name))]
        : [...inSection];
      const followed = stepPaths(elements, starts, req.segments, SECTION_ROUTE_MAX_PATHS + 1);
      if (followed.paths.length) search = followed;
    }
    if (!search) search = simplePaths(elements, [...inSection], target, SECTION_ROUTE_MAX_PATHS + 1);
    const paths = search.paths;
    if (paths.length === 0) continue;
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

// Caminos de la sección, Part 1: the same words as the prompt's lines
// (ruleTestExamplesPrompt.js, sectionRouteLines) on one line, for the
// correction round -- "<X> is not allowed inside <Y>" with X on one of the
// ways the rule's steps allow.
export function sectionRouteSentence(route) {
  const ways = route.paths.map((p) => p.join('/')).join('; ');
  if (route.several || !route.position) {
    return `<${route.target}> is not directly inside any element of that section. Valid ways down in this schema (use one of them): ${ways}.`;
  }
  const pos = route.position;
  const where = pos.after ? `right after <${pos.after}>` : pos.before ? `right before <${pos.before}>` : 'as its first child';
  return `<${route.target}> is not directly inside any element of that section. The valid way down in this schema: ${ways}. <${pos.container}> goes inside <${pos.parent}>, ${where}.`;
}

// The section's ways that pass through `element` (after their first step).
export function routesThrough(routes, element) {
  return (routes || []).filter((r) => r.paths.some((p) => p.indexOf(element) > 0));
}

// GMC, Part 1.2: the way from the identification and status section to an
// element that carries an attribute the rule checks (<reasonForUpdate> for
// //@updateReasonType) -- { path (from the section element), inMinimal,
// position, minimal, several }:
//   in the minimal section → its path there (inMinimal);
//   a direct child of one of its elements → that element's path, with where
//     it goes among the existing children (XSD order) and a minimum valid
//     one of it;
//   deeper → the same routes as <copyright> (sectionRoutes).
// null when it cannot be reached from the section.
export function sectionCarrierWay(structure, section, target) {
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  if (!section?.tree || !elements[target]) return null;
  const treePaths = new Map();
  const walk = (node, path) => {
    const here = [...path, node.name];
    if (!treePaths.has(node.name) || treePaths.get(node.name).length > here.length) treePaths.set(node.name, here);
    for (const child of node.children || []) walk(child, here);
  };
  walk(section.tree, []);
  if (treePaths.has(target)) return { path: treePaths.get(target), inMinimal: true, position: null, minimal: null, several: false };
  const nodes = treeNodes(section.tree);
  const parents = nodes
    .filter((n) => (elements[n.name]?.children || []).includes(target))
    .sort((a, b) => treePaths.get(a.name).length - treePaths.get(b.name).length);
  if (parents.length) {
    const parent = parents[0];
    const order = models[parent.name]?.order || [];
    const at = order.indexOf(target);
    const existing = (parent.children || []).map((c) => c.name).filter((n) => order.indexOf(n) >= 0);
    const after = at >= 0 ? [...existing].reverse().find((n) => order.indexOf(n) < at) : null;
    const before = at >= 0 ? existing.find((n) => order.indexOf(n) > at) : null;
    const position = after
      ? { parent: parent.name, container: target, after }
      : before
        ? { parent: parent.name, container: target, before }
        : { parent: parent.name, container: target, first: true };
    const leaf = minimalNode(models, target);
    return {
      path: [...treePaths.get(parent.name), target],
      inMinimal: false,
      position,
      minimal: leaf ? renderNode(leaf, { indent: '  ', placeholder: '…' }) : null,
      several: false,
    };
  }
  const [route] = sectionRoutes(structure, section, [target]);
  if (!route) return null;
  const full = (p) => [...(treePaths.get(p[0]) || [p[0]]), ...p.slice(1)];
  return { path: full(route.paths[0]), inMinimal: false, position: route.position, minimal: route.minimal, several: route.several, paths: route.paths.map(full) };
}

// ─── Part 2: moving a misplaced element down the only valid way ─────────────

// The required children the relocation itself builds around the next link
// (chainNode: a new <content> needs its <commonRepository>) carry this
// attribute while the relocation runs, and lose it before it returns.
const FILLER_ATTR = 'data-brdp-relocation-filler';
const FILLER_MARK_RE = new RegExp(`\\s${FILLER_ATTR}\\s*=\\s*"1"`);
const FILLER_STRIP_RE = new RegExp(`\\s${FILLER_ATTR}="1"`, 'g');

// Marks every node of the chain the relocation builds that is not on the
// way to the leaf (the required children chainNode adds around it). The
// way is the one child at each level that holds the leaf -- the LLM's raw
// text, never marked.
function holdsRaw(node) {
  return node.raw != null || node.children.some(holdsRaw);
}

function markFillers(node) {
  if (node.raw != null) return node;
  return { ...node, children: node.children.map((c) => (holdsRaw(c) ? markFillers(c) : markAll(c))) };
}

function markAll(node) {
  if (node.raw != null) return node;
  return { ...node, attributes: [...node.attributes, [FILLER_ATTR, '1']], children: node.children.map(markAll) };
}

// A filler the LLM's text has not gone into: it and everything in it was
// built by the relocation.
function pureFiller(node) {
  return node.filler && node.children.every(pureFiller);
}

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
      const node = {
        name: m[2],
        start: m.index,
        openEnd: m.index + m[0].length,
        closeStart: null,
        end: null,
        children: [],
        selfClosing: Boolean(m[4]),
        filler: FILLER_MARK_RE.test(m[3] || ''),
      };
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
    const insertText = renderNode(markFillers(chain));
    const firstName = path[i];
    const siblings = into.children.filter((c) => c !== node);
    // La recolocación no debe duplicar un elemento que la app ya creó: when
    // an earlier move built this container with a required <firstName>
    // (chainNode's minimal one -- BRDP-EXT-00134 in comrep: moving
    // <referencedApplicGroup> built <content> with a <commonRepository>)
    // and the schema allows at most one there, what is moved now takes its
    // place. Never an element the LLM wrote, nor one the LLM's text has
    // gone into since (pureFiller); with a higher maximum both stay.
    const filler =
      models[intoName]?.max?.[firstName] === 1
        ? siblings.find((c) => c.name === firstName && pureFiller(c))
        : null;
    let edits;
    if (filler) {
      edits = [
        { start: filler.start, end: filler.end, text: insertText },
        { start: node.start, end: node.end, text: '' },
      ];
    } else {
      const at = orderIndex(models, intoName, firstName, siblings.map((c) => c.name));
      const insertAt = at < siblings.length ? siblings[at].start : at > 0 ? siblings[at - 1].end : into.openEnd;
      edits = [
        { start: insertAt, end: insertAt, text: insertText },
        { start: node.start, end: node.end, text: '' },
      ];
    }
    // The later edit first, so the earlier one's offsets still hold (the
    // insertion first when both are at the same place: it goes before).
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    for (const e of edits) current = current.slice(0, e.start) + e.text + current.slice(e.end);
    moved.push({ element: node.name, parent: pName, path });
  }
  return { text: current.replace(FILLER_STRIP_RE, ''), moved };
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

// ─── Contenido suelto: wrapping loose children in a container ───────────────

// The children C of `parent` that can take every one of `names`: in the
// parent's model, no required attribute without a value, every required
// child covered by `names` (never fabricated), each of `names` allowed in C.
// → [{ name, ord }] in the XSD's order.
function containerCandidates(structure, parent, names) {
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  const order = models[parent]?.order || [];
  const set = new Set(names);
  const allowedIn = (p, name) => Boolean(elements[p]?.children?.includes(name));
  return order
    .filter((c, i) => {
      if (order.indexOf(c) !== i || !allowedIn(parent, c) || !models[c] || !elements[c]) return false;
      if ((models[c].attributes || []).some(([, v]) => v == null)) return false;
      if (![...set].every((n) => allowedIn(c, n))) return false;
      const required = models[c].required || [];
      return required.every((slot) => (Array.isArray(slot) ? slot : [slot]).some((n) => set.has(n)));
    })
    .map((c) => ({ name: c, ord: order.indexOf(c) }));
}

// `fits` ranked best first -- see wrapLooseContent: the most kinds of
// children; then the position next to the run's allowed siblings
// (`prev`/`next` names), or before the child the skeleton uses in `parent`
// when there is none; then the most document types (`related`, the
// structures of the other types: a dossier's topic, concept, task…) that
// have it; then the most parents in the schema; then the XSD's order.
function rankContainers(structure, parent, fits, { prev = null, next = null, related = [] } = {}) {
  const elements = structure?.elements || {};
  const order = structure?.models?.[parent]?.order || [];
  const ord = (n) => order.indexOf(n);
  const kinds = (c) => (elements[c]?.children || []).length;
  const parentsOf = (c) => Object.values(elements).filter((e) => (e.children || []).includes(c)).length;
  const types = (c) => (related || []).filter((st) => st?.elements?.[c]).length;
  const path = structure?.skeleton?.path || [];
  const spineAt = path.indexOf(parent);
  const spine = spineAt >= 0 && spineAt + 1 < path.length ? ord(path[spineAt + 1]) : -1;
  // Closeness to the anchor: the next allowed sibling, the previous one,
  // or the child the skeleton uses in the parent -- 0 with no anchor.
  const position = (c) => {
    if (next) return -c.ord;
    if (prev) return c.ord;
    if (spine >= 0) return c.ord < spine ? spine - c.ord : 1000 + c.ord;
    return 0;
  };
  return [...fits].sort(
    (a, b) =>
      kinds(b.name) - kinds(a.name) ||
      position(a) - position(b) ||
      types(b.name) - types(a.name) ||
      parentsOf(b.name) - parentsOf(a.name) ||
      a.ord - b.ord,
  );
}

// The container the application would wrap loose `names` in, inside
// `parent` with no other child (contenido suelto, Part 1: the prompt says
// where a sheet's content goes). null when there is none.
export function looseContainerFor(structure, parent, names, related = []) {
  const models = structure?.models || {};
  const fits = containerCandidates(structure, parent, names).filter((c) => (models[parent]?.max?.[c.name] ?? Infinity) >= 1);
  return rankContainers(structure, parent, fits, { related })[0]?.name || null;
}

// Test de reglas DITA: contenido suelto en el cuerpo de las fichas del dosier
// (BRDP-EXT-00014/00015, Navantia): the LLM wrote
// <task><taskbody><p/><table/><fig/></taskbody></task>; <taskbody> admits
// none of them, but its child <context> admits all three. There is no single
// way down for each one (relocateMisplacedElements does nothing: <p> fits in
// <prereq>, <context>, <result>, …), so the children are WRAPPED instead:
// a run of consecutive children of P that P does not allow (only whitespace
// or comments between them) goes into ONE container C that P allows and that
// admits every one of them.
//
// Which C: one of P's children (its XSD's order) whose model exists, with no
// required attribute without a value, whose required children are all
// covered by the run (never fabricated), and that admits every element of
// the run. Where: next to an existing C right before or after the run (then
// the run goes into it); otherwise a new C placed between the run's nearest
// allowed siblings (rankContainers): the candidate that admits the most
// kinds of children; among equals the one closest to the next sibling (the
// latest in the order before it), else the one closest after the previous
// one, else (no allowed sibling at all) the latest before the child the
// schema's skeleton uses in P (structure.skeleton.path: <steps> in
// <taskbody>); then the one more document types have (`related`: <section>
// rather than <refsyn> in <refbody>), then the one more elements allow, then
// the XSD's order. "The first in the XSD's order" alone would pick <prereq>
// in <taskbody> and <refsyn> in <refbody>: the generality and the
// neighbouring position tell a general container from a specific one, with
// no element name in the code. The count of C must
// stay within P's maximum. Nothing is done with no such C; the example then
// goes to the correction round as before.
//
// A run with a title element (DITA_TITLE_ELEMENTS) is never wrapped, nor
// split: the container would take it as its OWN title and the meaning would
// change (BRDP-EXT-00015, Navantia: <title>Tabla 1</title><table/> loose in
// <taskbody> became <example><title>Tabla 1</title><table/></example>, the
// example's title and no longer the table's). The whole run stays as it is
// and goes to the correction round with its structure problems.
//
// `keeps(before, after)` (optional) decides on the whole text whether a wrap
// may be applied: the caller runs the rule before and after and refuses a
// wrap that changes what the rule selects (a rule on taskbody/p).
// → { text, wrapped: [{ parent, container, elements, reused }] }
// DITA elements that are the title of their parent: in a container they
// would title the container, not what follows them.
export const DITA_TITLE_ELEMENTS = new Set(['title', 'navtitle', 'searchtitle', 'shortdesc']);

export function wrapLooseContent(text, structure, parentName, { keeps = null, related = [] } = {}) {
  const original = String(text ?? '');
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  if (!structure?.models || !Object.keys(models).length) return { text: original, wrapped: [] };
  const allowedIn = (p, name) => Boolean(elements[p]?.children?.includes(name));
  const gapIsBlank = (from, to) => /^\s*$/.test(current.slice(from, to).replace(/<!--[\s\S]*?-->/g, ''));
  let current = original;
  const wrapped = [];
  const skip = new Set();

  const candidatesFor = (p, run, siblings) =>
    containerCandidates(structure, p, run.map((c) => c.name)).map((c) => ({ ...c, existing: siblings.filter((s) => s.name === c.name).length }));

  const findRun = (top) => {
    const visit = (node, name) => {
      if (name && models[name] && elements[name]) {
        const kids = node.children;
        let i = 0;
        while (i < kids.length) {
          const loose = (k) => elements[k.name] && !allowedIn(name, k.name);
          if (!loose(kids[i])) {
            i += 1;
            continue;
          }
          let j = i;
          while (j + 1 < kids.length && loose(kids[j + 1]) && gapIsBlank(kids[j].end, kids[j + 1].start)) j += 1;
          const run = kids.slice(i, j + 1);
          const key = `${name}@${run[0].start}`;
          if (!skip.has(key)) return { node, name, run, from: i, to: j, key };
          i = j + 1;
        }
      }
      for (const child of node.children) {
        const found = visit(child, child.name);
        if (found) return found;
      }
      return null;
    };
    return visit(top, parentName);
  };

  for (let pass = 0; pass < 20; pass += 1) {
    const top = parseSpans(current);
    if (!top) return { text: original, wrapped: [] };
    const found = findRun(top);
    if (!found) break;
    const { node, name: p, run, from, to, key } = found;
    skip.add(key);
    if (run.some((c) => DITA_TITLE_ELEMENTS.has(c.name))) continue;
    const kids = node.children;
    const order = models[p]?.order || [];
    const ord = (n) => order.indexOf(n);
    let prev = null;
    for (let k = from - 1; k >= 0; k -= 1) if (allowedIn(p, kids[k].name)) { prev = kids[k]; break; }
    let next = null;
    for (let k = to + 1; k < kids.length; k += 1) if (allowedIn(p, kids[k].name)) { next = kids[k]; break; }
    const candidates = candidatesFor(p, run, kids);
    if (!candidates.length) continue;
    const runText = current.slice(run[0].start, run[run.length - 1].end);
    let edit;
    let container = null;
    let reused = false;
    const adjacent = (sib, before) => sib && !sib.selfClosing && candidates.some((c) => c.name === sib.name) && (before ? gapIsBlank(sib.end, run[0].start) : gapIsBlank(run[run.length - 1].end, sib.start));
    if (adjacent(prev, true)) {
      container = prev.name;
      reused = true;
      edit = (s) => s.slice(0, prev.closeStart) + current.slice(prev.end, run[0].start) + runText + s.slice(prev.closeStart, prev.end) + s.slice(run[run.length - 1].end);
    } else if (adjacent(next, false)) {
      container = next.name;
      reused = true;
      edit = (s) => s.slice(0, run[0].start) + s.slice(next.start, next.openEnd) + runText + current.slice(run[run.length - 1].end, next.start) + s.slice(next.openEnd);
    } else {
      const lo = prev ? ord(prev.name) : -Infinity;
      const hi = next ? ord(next.name) : Infinity;
      const fits = candidates.filter((c) => c.ord >= 0 && c.ord >= lo && c.ord <= hi && c.existing + 1 <= (models[p].max?.[c.name] ?? Infinity));
      const pick = rankContainers(structure, p, fits, { prev: prev?.name ?? null, next: next?.name ?? null, related })[0] || null;
      if (!pick) continue;
      container = pick.name;
      const attrs = (models[container].attributes || []).map(([n, v]) => ` ${n}="${escAttr(v)}"`).join('');
      edit = (s) => s.slice(0, run[0].start) + `<${container}${attrs}>${runText}</${container}>` + s.slice(run[run.length - 1].end);
    }
    const after = edit(current);
    // Valid for P: its allowed children in the XSD's order, within the
    // maxima. Never applied otherwise.
    const check = parseSpans(after);
    if (!check) continue;
    const parentNode = (function locate(n) {
      if (n.start === node.start && n.name === node.name) return n;
      for (const c of n.children) {
        const f = locate(c);
        if (f) return f;
      }
      return null;
    })(check);
    if (parentNode && models[p]) {
      const seq = parentNode.children.filter((c) => allowedIn(p, c.name)).map((c) => ord(c.name));
      const okOrder = seq.every((v, i) => i === 0 || v < 0 || seq[i - 1] < 0 || v >= seq[i - 1]);
      const counts = {};
      for (const c of parentNode.children) counts[c.name] = (counts[c.name] || 0) + 1;
      const okMax = Object.entries(models[p].max || {}).every(([n, m]) => (counts[n] || 0) <= m);
      if (!okOrder || !okMax) continue;
    }
    if (keeps && !keeps(current, after)) continue;
    current = after;
    wrapped.push({ parent: p, container, elements: [...new Set(run.map((c) => c.name))], reused });
  }
  return { text: current, wrapped };
}
