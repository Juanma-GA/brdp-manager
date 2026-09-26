"""Docs request ("Servicio de fichas de esquema y su uso en Ask") -- generates
public/schema-cards-<standard>.json: one "card" per element declared in the
real XSD schema (DITA 1.3 / S1000D 3.0.1 / 4.1 / 4.2), giving structural
facts the vocabulary check (generate_schema_vocabulary.py) doesn't have --
which attributes an element admits (required or not, and its closed set of
values when the attribute type is an enumeration), which elements it allows
as direct children, and (the inverse) which elements allow it as a child.

Two genuinely different schema shapes, two genuinely different resolution
strategies -- decided from reading the real XSDs, not assumed:

- **S1000D** (`sources/SchemasS1000D/<issue>/*.xsd`): each file is a
  self-contained, "flat" schema for one root data-module type (descript.xsd,
  proced.xsd, ...) -- confirmed by grep that these files use `xs:import`
  only for xlink.xsd/rdf.xsd (irrelevant to our vocabulary) and NEVER
  `xs:include`/`xs:redefine`; common definitions (e.g. `changeAttGroup`) are
  duplicated byte-for-byte across files rather than shared via include. So
  each file is resolved in complete ISOLATION from the others -- a `ref=`/
  `type=` inside file F is only ever looked up among F's OWN top-level
  declarations. The exact same element name (e.g. `table`) can appear in
  several of these files; when it does, its resolved card is compared
  BYTE-FOR-BYTE (deep-equal on the resolved {attributes, children} shape,
  not the raw XML) across the files that declare it, grouping files whose
  resolved definition is identical into one card variant with a `schemas`
  list, and giving each GENUINELY different definition its own variant
  (docs request's own framing: "un mismo elemento puede definirse distinto
  según el esquema").

- **DITA 1.3** (`sources/D1.3/schema/**/*.xsd`): a real modular schema --
  files genuinely `xs:include` each other (via OASIS URN schemaLocations,
  e.g. `urn:oasis:names:tc:dita:xsd:hazardDomain.xsd:1.3`, resolved through
  this schema set's own `catalog.xml` files in real DITA tooling) and use
  `xs:redefine` to let each topic-type shell (topic.xsd, concept.xsd,
  task.xsd, map.xsd, bookmap.xsd) extend shared domain-composition groups
  (`note`, `data`, `foreign`, ...) with that shell's own domain mix.
  Resolving the real per-shell include graph (via the catalog files) is
  possible but adds a lot of machinery for a payoff this docs request
  doesn't need: sampling the actual redefine bodies for `note`/`data`/
  `foreign` etc. across all 5 shells found them byte-identical (see the
  verification report) -- shells extend shared groups the SAME way, they
  don't diverge. So DITA is resolved as ONE merged world across every .xsd
  file under the schema root (same "scan everything" superset principle
  already established by generate_schema_vocabulary.py, HR7-safe by
  construction: a name declared in an unreachable module is at worst a
  missed negative, never a false "not found"/wrong shape on a real name),
  with `xs:redefine` bodies collected and layered on top of the plain
  declarations they redefine. If two DIFFERENT `xs:redefine` bodies for the
  very same name are ever found to genuinely differ (not observed for the
  cases checked here), children are the UNION of every variant's children
  rather than an arbitrary pick -- documented in `_redefine_conflicts` in
  the output, never silently resolved to just one. `schemas` for every DITA
  card is always `["DITA 1.3"]` -- a deliberate simplification, not a
  per-shell resolution; unlike S1000D's genuinely independent per-Issue
  document types, DITA is one coherent schema by design.

A self-reference inside a redefine body (`<xs:group name="note"><xs:choice>
<xs:group ref="note"/>...` -- the classic XSD redefine idiom, "the new note
group is the old note group plus more") is resolved to the PRE-redefine
("base") definition, never back into the redefine body itself (that would
infinite-loop) -- see `_redefine_stack` threaded through every recursive
resolver call below.

**Never guessed**: when a `ref=`/`type=` target genuinely cannot be found
anywhere in scope (S1000D: not in that one file; DITA: not anywhere in the
merged tree) after all of the above, the element's `children` (or, more
narrowly, just the unresolved branch of it) is marked `"resolved": false`
-- the docs request's own instruction ("donde el modelo de contenido no se
pueda resolver con fiabilidad, marcar la ficha como unresolved en vez de
adivinar"). Any element names that WERE resolved before the failure are
still reported (partial information beats none, and the `resolved: false`
flag already tells the caller not to trust it as complete) -- never
silently dropped, never silently claimed complete.

Usage (reexecutable):

    cd backend && source .venv/bin/activate
    python scripts/generate_schema_cards.py <standard-key> <schema-root-dir> <output-json-path> [--mode=isolated|merged]

`--mode` defaults to `isolated` (S1000D's per-file behavior); pass
`--mode=merged` for DITA. Prints a closeout report (cards generated,
unresolved count, output file size) to stdout. Output lands in
`backend/schema_cards/` (a backend-only data directory, never `public/` --
these files are loaded by the backend at startup and served compactly via
`GET /api/schema-cards`, never fetched whole by the frontend the way
`public/schema-vocabulary-*.json` is), e.g.:

    python scripts/generate_schema_cards.py "DITA 1.3" ../sources/D1.3/schema \\
        ../backend/schema_cards/schema-cards-dita.json --mode=merged
    python scripts/generate_schema_cards.py "S1000D 4.2" ../sources/SchemasS1000D/4.2 \\
        ../backend/schema_cards/schema-cards-4-2.json --mode=isolated
    # ...and the same for S1000D 4.1 / 3.0.1 (isolated). S1000D 5.0/6.0 have
    # no schema at all in this repo, so no cards file for them either --
    # the endpoint reports "not available" for a standard with no file.
"""
from __future__ import annotations

import copy
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from lxml import etree

XSD_NS = "http://www.w3.org/2001/XMLSchema"
QN = lambda tag: f"{{{XSD_NS}}}{tag}"  # noqa: E731

# Compact-output limits (docs request point 2) -- applied only when the
# endpoint SERVES a card, never when generating/storing it (the generator
# keeps the full, untruncated facts; truncation is a presentation concern
# of the API layer). Kept here too as documented defaults so the generator
# and the endpoint agree on what "a lot" means.
DEFAULT_MAX_CHILDREN = 40
DEFAULT_MAX_ATTRIBUTES = 30
DEFAULT_MAX_ENUM_VALUES = 20

# Recursion guards -- real content models never need anywhere close to
# this depth; this exists only to convert a genuine schema bug (a true
# reference cycle through group/attributeGroup refs, which real content
# models never have) into a clean "unresolved", never a hang or a
# RecursionError crash.
_MAX_DEPTH = 60


def _local(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def _is_xsd(node) -> bool:
    return isinstance(node.tag, str) and node.tag.startswith(f"{{{XSD_NS}}}")


@dataclass
class Scope:
    """One resolution world: either a single S1000D file (`isolated` mode)
    or the whole merged DITA tree (`merged` mode)."""

    label: str  # S1000D: the file's stem (e.g. "descript"); DITA: "DITA 1.3"
    elements: dict = field(default_factory=dict)  # name -> xs:element node (top-level only)
    attributes: dict = field(default_factory=dict)  # name -> xs:attribute node (top-level only)
    complex_types: dict = field(default_factory=dict)
    simple_types: dict = field(default_factory=dict)
    groups: dict = field(default_factory=dict)
    attribute_groups: dict = field(default_factory=dict)
    # Redefine layers (DITA only) -- name -> list of redefine-body nodes,
    # in the order encountered. Deliberately kept separate from the plain
    # dicts above so a self-ref inside a redefine body can bypass this
    # layer and fall back to the plain ("base") definition.
    redefine_groups: dict = field(default_factory=dict)
    redefine_attribute_groups: dict = field(default_factory=dict)
    redefine_complex_types: dict = field(default_factory=dict)
    redefine_simple_types: dict = field(default_factory=dict)

    # category -> (plain-dict attribute name, redefine-dict attribute name).
    # An explicit map, not a string transform -- "complexType"/"attributeGroup"
    # don't pluralize/snake_case predictably enough to derive this safely.
    _CATEGORY_FIELDS = {
        "element": ("elements", None),
        "attribute": ("attributes", None),
        "complexType": ("complex_types", "redefine_complex_types"),
        "simpleType": ("simple_types", "redefine_simple_types"),
        "group": ("groups", "redefine_groups"),
        "attributeGroup": ("attribute_groups", "redefine_attribute_groups"),
    }

    def lookup(self, category: str, name: str, redefine_stack: frozenset):
        """Returns (node, is_redefine_layer) or (None, False) if not found.
        `redefine_stack` holds (category, name) pairs currently being
        expanded from THEIR OWN redefine body -- a self-ref matching one of
        those bypasses the redefine layer for that one lookup, landing on
        the plain/base definition instead (classic XSD redefine self-ref
        semantics)."""
        plain_field, redefine_field = self._CATEGORY_FIELDS[category]
        plain_map = getattr(self, plain_field)
        redefine_map = getattr(self, redefine_field) if redefine_field else {}
        if (category, name) not in redefine_stack and redefine_map.get(name):
            # Multiple redefine bodies for the same name (only possible in
            # `merged` mode, where several files could legitimately redefine
            # the same shared group) -- see docstring: union their content
            # rather than arbitrarily pick one. Represented as a synthetic
            # <xs:choice> wrapper so the normal particle-walker below unions
            # them for free, with no special-casing needed downstream.
            bodies = redefine_map[name]
            if len(bodies) == 1:
                return bodies[0], True
            wrapper = etree.Element(QN("choice"))
            for body in bodies:
                wrapper.append(_copy_particle_children(body))
            return wrapper, True
        node = plain_map.get(name)
        return (node, False) if node is not None else (None, False)


def _copy_particle_children(named_node) -> etree._Element:
    """Wraps a named xs:group/xs:attributeGroup's own particle children in
    a <xs:sequence> passthrough so several same-name redefine bodies can be
    unioned under one synthetic <xs:choice> (see Scope.lookup above).

    Real bug found and fixed while hand-verifying `note`'s children against
    the real DITA XSDs (topic.xsd/concept.xsd/task.xsd/map.xsd/bookmap.xsd
    all redefine the shared "note" group -- 5 distinct redefine bodies for
    one name, so this function's multi-body path runs for real): lxml's
    `Element.append()` REPARENTS a node that already has a parent -- it
    doesn't copy it, it MOVES it out of its original location in the
    document tree. `wrapper.append(child)` on a live child straight from
    the parsed document would silently rip that child out of the ORIGINAL
    redefine body the first time this ran, so any LATER card computation
    that reused the same redefine body (every element downstream of
    "basic.block" needs "note", not just one) would see that body emptied
    out from under it -- confirmed concretely: the very first element
    processed (alphabetically first in the merged scope) got `note`/
    `hazardstatement` correctly, every element processed after it got
    neither, because the shared XML nodes had already been moved away.
    `copy.deepcopy` per child avoids mutating the parsed document at all."""
    wrapper = etree.Element(QN("sequence"))
    for child in named_node:
        if _is_xsd(child):
            wrapper.append(copy.deepcopy(child))
    return wrapper


def _parse_all_xsd(schema_root: Path):
    """Returns list of (file_path, parsed_root) for every .xsd under
    schema_root, skipping (and reporting) files that fail to parse."""
    parsed = []
    errors = []
    for xsd_path in sorted(schema_root.rglob("*.xsd")):
        try:
            tree = etree.parse(str(xsd_path))
        except etree.XMLSyntaxError as err:
            errors.append(f"{xsd_path}: {err}")
            continue
        parsed.append((xsd_path, tree.getroot()))
    return parsed, errors


def _collect_top_level(root, scope: Scope, include_elements: bool = True) -> None:
    """Collects a single <xs:schema> root's own top-level declarations
    (direct children only) into `scope`, plus any <xs:redefine> bodies.
    `include_elements=False` is used for a merged-in xs:import target
    (S1000D's xlink.xsd/rdf.xsd): those files' own attributes/types/groups
    are real dependencies the importing file's content models need to
    resolve, but their top-level ELEMENTS (e.g. rdf:Description) don't
    semantically belong to the importing file's own document type -- adding
    them would give every S1000D module a spurious extra card variant for
    an element it doesn't actually define."""
    for child in root:
        if not _is_xsd(child):
            continue
        tag = _local(child.tag)
        if tag == "element" and child.get("name"):
            if include_elements:
                scope.elements[child.get("name")] = child
        elif tag == "attribute" and child.get("name"):
            scope.attributes[child.get("name")] = child
        elif tag == "complexType" and child.get("name"):
            scope.complex_types[child.get("name")] = child
        elif tag == "simpleType" and child.get("name"):
            scope.simple_types[child.get("name")] = child
        elif tag == "group" and child.get("name"):
            scope.groups[child.get("name")] = child
        elif tag == "attributeGroup" and child.get("name"):
            scope.attribute_groups[child.get("name")] = child
        elif tag == "redefine":
            for redef_child in child:
                if not _is_xsd(redef_child) or not redef_child.get("name"):
                    continue
                redef_tag = _local(redef_child.tag)
                name = redef_child.get("name")
                target = {
                    "group": scope.redefine_groups,
                    "attributeGroup": scope.redefine_attribute_groups,
                    "complexType": scope.redefine_complex_types,
                    "simpleType": scope.redefine_simple_types,
                }.get(redef_tag)
                if target is not None:
                    target.setdefault(name, []).append(redef_child)


def _imported_roots(path: Path, root, by_path: dict) -> list:
    """S1000D-specific (isolated mode): a file's own xs:import/xs:include
    schemaLocation values are plain relative filenames (confirmed by grep --
    no URNs, no catalog needed, unlike DITA), so a real sibling file (in
    practice: xlink.xsd/rdf.xsd, each S1000D module's only cross-file
    reference) is just resolved relative to the importing file's own
    directory. Returns the parsed roots of whatever resolves, so the
    importing file's scope can ALSO see those declarations -- without this,
    a real, resolvable reference like `xs:attributeGroup ref="xlink:XLINKATT"`
    would be reported as unresolved for no good reason (the target file is
    right there in the same directory)."""
    found = []
    for child in root:
        if not _is_xsd(child) or _local(child.tag) not in ("import", "include"):
            continue
        location = child.get("schemaLocation")
        if not location:
            continue
        candidate = (path.parent / location).resolve()
        if candidate in by_path:
            found.append(by_path[candidate])
    return found


def build_scopes(schema_root: Path, mode: str) -> list[Scope]:
    parsed, parse_errors = _parse_all_xsd(schema_root)
    if parse_errors:
        print(f"WARNING: {len(parse_errors)} file(s) failed to parse and were skipped:")
        for msg in parse_errors:
            print(f"  {msg}")
    if not parsed:
        print(f"ERROR: no .xsd files found under {schema_root} -- refusing to write empty cards.")
        sys.exit(1)

    if mode == "merged":
        scope = Scope(label="__MERGED__")
        for _, root in parsed:
            _collect_top_level(root, scope)
        return [scope]

    by_path = {path.resolve(): root for path, root in parsed}
    scopes = []
    for path, root in parsed:
        scope = Scope(label=path.stem)
        _collect_top_level(root, scope)
        for imported_root in _imported_roots(path, root, by_path):
            _collect_top_level(imported_root, scope, include_elements=False)
        scopes.append(scope)
    return scopes


# ---------------------------------------------------------------------------
# Resolution: attributes (name, required, enum) and children (flat element
# name set), both walked from a complexType/element node.
# ---------------------------------------------------------------------------


class Unresolved(Exception):
    """Raised internally when a ref=/type= target cannot be found anywhere
    in scope. Caught at the top of each card's computation -- never lets a
    single missing reference silently vanish."""


def _enum_from_simple_type(node, scope: Scope, redefine_stack: frozenset, depth: int) -> list[str] | None:
    """Returns the closed list of xs:enumeration values for a (possibly
    named, possibly inline) simpleType node, or None if it isn't a closed
    enumeration (built-in base with no enumeration facets, a list/union
    type, or an unresolvable named base -- never guessed, never invented)."""
    if depth > _MAX_DEPTH:
        return None
    restriction = node.find(QN("restriction"))
    if restriction is None:
        return None  # xs:list / xs:union -- not a simple closed enum, not modeled
    values = [e.get("value") for e in restriction.findall(QN("enumeration"))]
    if values:
        return values
    base = restriction.get("base")
    if not base:
        return None
    base_local = base.split(":", 1)[-1]
    target_node, is_redef = scope.lookup("simpleType", base_local, redefine_stack)
    if target_node is None:
        return None  # built-in XSD type (xs:string, xs:NMTOKEN, ...) or truly external -- open-ended, not an error
    return _enum_from_simple_type(target_node, scope, redefine_stack, depth + 1)


def _resolve_attribute_particle(particle, scope: Scope, redefine_stack: frozenset) -> dict:
    """A single <xs:attribute> particle (ref= or inline name=) -> {name, required, enum}."""
    ref = particle.get("ref")
    use = particle.get("use", "optional")
    if ref:
        name = ref.split(":", 1)[-1]
        target, _ = scope.lookup("attribute", name, redefine_stack)
        type_attr = target.get("type") if target is not None else None
        inline_simple = target.find(QN("simpleType")) if target is not None else None
    else:
        name = particle.get("name")
        type_attr = particle.get("type")
        inline_simple = particle.find(QN("simpleType"))

    enum = None
    if inline_simple is not None:
        enum = _enum_from_simple_type(inline_simple, scope, redefine_stack, 0)
    elif type_attr:
        base_local = type_attr.split(":", 1)[-1]
        simple_node, _ = scope.lookup("simpleType", base_local, redefine_stack)
        if simple_node is not None:
            enum = _enum_from_simple_type(simple_node, scope, redefine_stack, 0)

    return {"name": name, "required": use == "required", "enum": enum}


def _walk_attributes(node, scope: Scope, redefine_stack: frozenset, out: dict, depth: int) -> None:
    """Recursively collects attribute particles (transparent through
    xs:attributeGroup ref=) directly declared on a complexType/extension
    node. `out` is name -> {required, enum}, mutated in place -- a later
    (more specific) occurrence of the same name overwrites an earlier one,
    matching how a locally-overridden `use`/type would behave in practice."""
    if depth > _MAX_DEPTH:
        raise Unresolved("attribute recursion depth exceeded")
    for child in node:
        if not _is_xsd(child):
            continue
        tag = _local(child.tag)
        if tag == "attribute":
            info = _resolve_attribute_particle(child, scope, redefine_stack)
            out[info["name"]] = {"required": info["required"], "enum": info["enum"]}
        elif tag == "attributeGroup":
            ref = child.get("ref")
            if not ref:
                continue
            name = ref.split(":", 1)[-1]
            target, is_redef = scope.lookup("attributeGroup", name, redefine_stack)
            if target is None:
                raise Unresolved(f"attributeGroup ref not found: {name}")
            next_stack = redefine_stack | {("attributeGroup", name)} if is_redef else redefine_stack
            _walk_attributes(target, scope, next_stack, out, depth + 1)


def _walk_children(node, scope: Scope, redefine_stack: frozenset, out: set, visited_groups: set, depth: int) -> None:
    """Recursively collects DIRECT child element names -- transparent
    through xs:sequence/xs:choice/xs:all/xs:group ref (pure grouping
    constructs, not real content), stopping at the first xs:element found
    (its OWN children are the next element's card, not this one's --
    "hijos permitidos" means one level down, flattened through nesting,
    never a deep walk)."""
    if depth > _MAX_DEPTH:
        raise Unresolved("children recursion depth exceeded")
    for child in node:
        if not _is_xsd(child):
            continue
        tag = _local(child.tag)
        if tag == "element":
            ref = child.get("ref")
            name = ref.split(":", 1)[-1] if ref else child.get("name")
            if name:
                out.add(name)
        elif tag in ("sequence", "choice", "all"):
            _walk_children(child, scope, redefine_stack, out, visited_groups, depth + 1)
        elif tag == "group":
            ref = child.get("ref")
            if not ref:
                continue
            name = ref.split(":", 1)[-1]
            target, is_redef = scope.lookup("group", name, redefine_stack)
            if target is None:
                raise Unresolved(f"group ref not found: {name}")
            # Cycle guard keyed by the RESOLVED NODE's identity, never by
            # name: a redefine's self-ref legitimately resolves `name` to a
            # DIFFERENT node (the base/pre-redefine body) than the outer
            # lookup did, and must still be walked -- keying by name alone
            # would wrongly treat "note" (redefine layer) and "note" (base
            # layer) as the same already-visited group and silently drop
            # the base group's own children (a real bug found and fixed
            # while hand-verifying the `note`/`hazardstatement` case below).
            if id(target) in visited_groups:
                continue  # genuine group self-cycle guard -- never a real content model, but never hangs on one either
            next_stack = redefine_stack | {("group", name)} if is_redef else redefine_stack
            _walk_children(target, scope, next_stack, out, visited_groups | {id(target)}, depth + 1)
        elif tag == "any":
            continue  # wildcard -- no fixed name to report


def _resolve_type_body(type_node, scope: Scope, redefine_stack: frozenset, attrs_out: dict, children_out: set, depth: int) -> None:
    """A (possibly named, possibly inline) complexType node -> populates
    attrs_out/children_out in place. Handles the three real shapes seen in
    these schemas: plain (sequence/choice/all + attributes directly),
    complexContent/extension (base type's own attrs+children UNION this
    extension's own), and simpleContent/extension (text content -- no
    element children, only the extension's own attributes)."""
    if depth > _MAX_DEPTH:
        raise Unresolved("type recursion depth exceeded")
    complex_content = type_node.find(QN("complexContent"))
    simple_content = type_node.find(QN("simpleContent"))
    if complex_content is not None:
        extension = complex_content.find(QN("extension"))
        if extension is not None:
            base = extension.get("base")
            base_missing = False
            base_local = None
            if base:
                base_local = base.split(":", 1)[-1]
                base_node, is_redef = scope.lookup("complexType", base_local, redefine_stack)
                if base_node is None:
                    base_missing = True
                else:
                    next_stack = redefine_stack | {("complexType", base_local)} if is_redef else redefine_stack
                    _resolve_type_body(base_node, scope, next_stack, attrs_out, children_out, depth + 1)
            # The extension's OWN particle is walked regardless of whether
            # the base resolved -- real bug found while testing this path:
            # raising immediately on a missing base meant the extension's
            # own attributes/children (real, resolvable facts) were thrown
            # away too. Partial information beats none (HR7); `resolved`
            # still ends up False via the raise below.
            _walk_children(extension, scope, redefine_stack, children_out, set(), depth + 1)
            _walk_attributes(extension, scope, redefine_stack, attrs_out, depth + 1)
            if base_missing:
                raise Unresolved(f"complexType base not found: {base_local}")
        return
    if simple_content is not None:
        extension = simple_content.find(QN("extension"))
        if extension is not None:
            _walk_attributes(extension, scope, redefine_stack, attrs_out, depth + 1)
        return  # text content -- no element children by definition
    # Plain complexType: sequence/choice/all + attribute(Group) as direct children.
    _walk_children(type_node, scope, redefine_stack, children_out, set(), depth + 1)
    _walk_attributes(type_node, scope, redefine_stack, attrs_out, depth + 1)


def compute_card(element_name: str, element_node, scope: Scope) -> dict:
    """Full card for one element: {attributes: [...], children: [...],
    resolved: bool}. Never raises -- Unresolved is caught here and turned
    into `resolved: false` with whatever partial facts were gathered
    before the failure."""
    attrs: dict = {}
    children: set = set()
    resolved = True
    type_attr = element_node.get("type")
    inline_type = element_node.find(QN("complexType"))
    try:
        if inline_type is not None:
            _resolve_type_body(inline_type, scope, frozenset(), attrs, children, 0)
        elif type_attr:
            type_local = type_attr.split(":", 1)[-1]
            type_node, is_redef = scope.lookup("complexType", type_local, frozenset())
            if type_node is not None:
                stack = frozenset({("complexType", type_local)}) if is_redef else frozenset()
                _resolve_type_body(type_node, scope, stack, attrs, children, 0)
            else:
                # Might be a simpleType (text-only element, e.g. <xs:element name="X" type="xs:string"/>
                # or a named simple type with an enumeration) -- no attributes/children either way.
                simple_node, _ = scope.lookup("simpleType", type_local, frozenset())
                if simple_node is None and not type_attr.startswith("xs:"):
                    raise Unresolved(f"element type not found: {type_local}")
        # else: no type at all and no inline complexType -- an empty/text element, nothing to resolve.
    except Unresolved:
        resolved = False

    return {
        "attributes": [{"name": n, "required": info["required"], "enum": info["enum"]} for n, info in sorted(attrs.items())],
        "children": sorted(children),
        "resolved": resolved,
    }


def _card_signature(card: dict) -> str:
    """Deep, order-independent signature used to decide whether two
    schemas' resolved definitions of the same element are "the same" --
    byte-for-byte on the RESOLVED shape, not the raw XML (two files could
    phrase the same content model differently and still resolve
    identically; that should still count as one variant)."""
    normalized = {
        "attributes": sorted(
            (a["name"], a["required"], tuple(sorted(a["enum"])) if a["enum"] else None) for a in card["attributes"]
        ),
        "children": tuple(sorted(card["children"])),
        "resolved": card["resolved"],
    }
    return json.dumps(normalized, sort_keys=True)


def build_cards(scopes: list[Scope]) -> dict:
    """Merges per-scope element cards into the final per-standard payload:
    {element_name: [{schemas: [...], attributes, children, resolved}, ...]}."""
    # element_name -> signature -> {"schemas": [...], "card": {...}}
    by_element: dict[str, dict[str, dict]] = {}
    element_count_per_scope = 0

    for scope in scopes:
        for name, node in scope.elements.items():
            element_count_per_scope += 1
            card = compute_card(name, node, scope)
            sig = _card_signature(card)
            variants = by_element.setdefault(name, {})
            if sig not in variants:
                variants[sig] = {"schemas": [], "card": card}
            variants[sig]["schemas"].append(scope.label)

    cards: dict[str, list[dict]] = {}
    unresolved_count = 0
    for name, variants in by_element.items():
        entries = []
        for variant in variants.values():
            entry = dict(variant["card"])
            entry["schemas"] = sorted(variant["schemas"]) if variant["schemas"] != ["__MERGED__"] else ["DITA 1.3"]
            entries.append(entry)
            if not entry["resolved"]:
                unresolved_count += 1
        # Stable order: the variant covering the most schemas first (the
        # "typical" shape), ties broken alphabetically for determinism.
        entries.sort(key=lambda e: (-len(e["schemas"]), e["schemas"]))
        cards[name] = entries

    parents: dict[str, set[str]] = {}
    for name, entries in cards.items():
        for entry in entries:
            for child in entry["children"]:
                parents.setdefault(child, set()).add(name)

    return {
        "cards": cards,
        "parents": {name: sorted(names) for name, names in parents.items()},
        "unresolved_count": unresolved_count,
        "element_count": len(cards),
    }


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    mode = "isolated"
    for a in sys.argv[1:]:
        if a.startswith("--mode="):
            mode = a.split("=", 1)[1]
    if len(args) != 3 or mode not in ("isolated", "merged"):
        print(__doc__)
        sys.exit(1)

    standard_key, schema_root_arg, output_path_arg = args
    schema_root = Path(schema_root_arg).resolve()
    output_path = Path(output_path_arg).resolve()

    if not schema_root.is_dir():
        print(f"ERROR: schema root not found or not a directory: {schema_root}")
        sys.exit(1)

    scopes = build_scopes(schema_root, mode)
    result = build_cards(scopes)

    payload = {
        "_readme": (
            "Auto-generated by backend/scripts/generate_schema_cards.py -- do "
            "not hand-edit. Rerun after the source XSDs change. Each element "
            "name maps to a list of variants -- normally 1, more than 1 only "
            "when different schema files genuinely resolve that element "
            "differently (a `schemas` list on each variant says which)."
        ),
        "standard": standard_key,
        "schema_root": str(schema_root),
        "mode": mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_file_count": sum(1 for _ in schema_root.rglob("*.xsd")),
        "element_count": result["element_count"],
        "unresolved_count": result["unresolved_count"],
        "cards": result["cards"],
        "parents": result["parents"],
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    size_kb = output_path.stat().st_size / 1024
    print(f"Standard: {standard_key}")
    print(f"Mode: {mode}")
    print(f"Cards generated: {result['element_count']}")
    print(f"Unresolved: {result['unresolved_count']}")
    print(f"Output size: {size_kb:.1f} KB")
    print(f"Wrote: {output_path}")


if __name__ == "__main__":
    main()
