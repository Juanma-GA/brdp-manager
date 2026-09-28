"""Test rule (T2b): per-schema skeletons and compact schema structure.

The "Test rule" panel no longer lets the LLM write a whole document. For each
S1000D schema the application owns a minimal skeleton -- a chain of real
parent/child elements from the schema's root (dmodule, pm, ...) down to an
insertion point, normally <para> -- and the LLM only writes the content that
goes inside that insertion point. The skeleton is DERIVED from the schema
cards (backend/schema_cards/*.json, the real XSDs), never written by hand:

  graph   the schema's element graph: for every element that has a card
          variant listing this schema, its direct children and attribute
          names (variants are per schema file, so each schema gets exactly
          the content model its own XSD declares).
  root    the element of the graph that no other element of the graph has
          as a child (rdf's <Description> aside): dmodule for the data module
          schemas, pm, dml, ddn, comment, dataUpdateFile, icnMetadataFile,
          scormContentPackage for the others.
  path    the cheapest root→para chain (Dijkstra) that never goes through an
          element of SKELETON_EXCLUDED (identification/status, references,
          warnings/cautions/notes, titles, figures/tables/lists, inline
          markup, preliminary/closing requirements -- things that are not
          the body of the document), where each step costs 1 except a step
          into a structural paragraph container (STRUCTURAL_CONTAINERS:
          levelledPara, proceduralStep, ... ), which costs 0; ties go to the
          chain with more structural containers. That yields e.g.
          descript: dmodule/content/description/levelledPara/para and
          proced: dmodule/content/procedure/mainProcedure/proceduralStep/para
          (4.x), dmodule/content/proced/mainfunc/step1/para (3.0.1).
  fallback  schemas with no such chain to <para> (ipd, pm, dml, ddn, the
          cross-reference tables, wiring, ...): the insertion point is the
          schema's body -- root/<content element>/<the content element's
          child with the most children> -- or the content element, or the
          root itself (3.0.1 ddn/dml have no content wrapper). Documented in
          CLAUDE.md's table.

DITA (T4): the DITA cards are one merged schema ("DITA 1.3"), so the
"schemas" of a DITA standard are its topic types instead -- DITA_DOCUMENT_TYPES
(topic, concept, task, reference, troubleshooting, map):

  graph   every element reachable from the type's root element without
          entering another topic or map type (a nested <task> inside a
          <topic> is another document), children filtered to that set.
  path    the cheapest chain root → insertion target that never goes through
          DITA_SKELETON_EXCLUDED (title, shortdesc, prolog, notes, tables,
          figures, lists, …): <step> for task (task/taskbody/steps/step), the
          type's body for the others (topic/body, concept/conbody,
          reference/refbody, troubleshooting/troublebody), the root alone
          for map.

Every link of every derived skeleton is re-checked against the cards by
backend/tests/test_rule_test_skeletons.py.
"""
import heapq
from functools import lru_cache

from app.services.schema_cards import (
    _CARDS_BY_FILE,
    DITA_DOCUMENT_TYPES,
    _NON_DOCUMENT_SCHEMAS,
    STANDARD_TO_SCHEMA_CARDS_FILE,
)

# Roots of the S1000D schemas, in the order used to break a tie when a graph
# has more than one parentless element (same list as ruleTestEngine.js's
# WHOLE_DOCUMENT_ROOTS).
DOCUMENT_ROOTS = (
    "dmodule", "pm", "dml", "ddn", "comment", "dataUpdateFile", "scormContentPackage", "icnMetadataFile",
)

# Never part of a skeleton: not the body of a document (see module docstring).
SKELETON_EXCLUDED = frozenset({
    # identification and status, references, applicability groups
    "identAndStatusSection", "idstatus", "imfIdentAndStatusSection", "updateIdentAndStatusSection", "cstatus",
    "Description", "refs", "referencedApplicGroup", "referencedApplicGroupRef",
    # safety statements and notes
    "warningsAndCautions", "warningsAndCautionsRef", "caution", "warning", "note",
    # titles, figures, tables, lists
    "title", "subtitle", "caption", "captionGroup", "figure", "figureAlts", "table", "foldout",
    "multimedia", "multimediaAlts", "randomList", "sequentialList", "definitionList", "listItem",
    "randlist", "seqlist", "deflist", "legend",
    # inline markup and copyright text
    "footnote", "ftnote", "emphasis", "copyright", "copyrightPara", "changeInline", "change", "prompt",
    # preliminary / closing requirements
    "preliminaryRqmts", "closeRqmts", "prelreqs", "closereqs", "reqCondGroup", "reqconds",
})

# Structural paragraph containers: a step into one costs nothing, so the
# skeleton goes through the document's real paragraph structure
# (levelledPara, procedural steps) rather than a bare <para> straight under
# the body.
STRUCTURAL_CONTAINERS = frozenset({
    "levelledPara", "para0", "mainProcedure", "proceduralStep", "mainfunc", "step1",
    "dmSeq", "dmNode", "dm-seq", "dm-node",
})

INSERTION_TARGET = "para"
_MAX_DEPTH = 10

# ─── DITA (T4) ───────────────────────────────────────────────────────────────
# Other documents: never entered while building a type's graph.
DITA_NESTED_TYPES = frozenset({
    "topic", "concept", "task", "reference", "troubleshooting", "glossentry", "glossgroup",
    "learningAssessment", "learningContent", "learningOverview", "learningPlan", "learningSummary",
    "map", "bookmap", "subjectScheme", "learningMap", "learningBookmap", "classifyMap",
})
DITA_SKELETON_EXCLUDED = frozenset({
    "title", "titlealts", "shortdesc", "abstract", "prolog", "related-links",
    "note", "hazardstatement", "table", "simpletable", "fig", "ul", "ol", "sl", "dl", "example",
    "refbodydiv", "bodydiv", "conbodydiv", "div", "section", "prereq", "context", "result", "postreq",
})
DITA_INSERTION_TARGET = {"task": "step"}


def is_dita_standard(standard: str) -> bool:
    return STANDARD_TO_SCHEMA_CARDS_FILE.get(standard) == "schema-cards-dita.json"


def _cards_for(standard: str) -> dict | None:
    filename = STANDARD_TO_SCHEMA_CARDS_FILE.get(standard)
    return _CARDS_BY_FILE.get(filename) if filename else None


def _dita_graph(data: dict, root: str) -> dict[str, dict] | None:
    cards = data.get("cards", {})
    if root not in cards:
        return None
    full = {
        name: {
            "children": list(variants[0].get("children", [])),
            "attributes": [a["name"] for a in variants[0].get("attributes", [])],
        }
        for name, variants in cards.items()
        if variants
    }
    reached = {root}
    frontier = [root]
    while frontier:
        nxt = []
        for name in frontier:
            for child in full[name]["children"]:
                if child in full and child not in reached and child not in DITA_NESTED_TYPES:
                    reached.add(child)
                    nxt.append(child)
        frontier = nxt
    return {
        name: {
            # a nested copy of the root type is another document too
            "children": [c for c in full[name]["children"] if c in reached and c != root],
            "attributes": full[name]["attributes"],
        }
        for name in sorted(reached)
    }


@lru_cache(maxsize=256)
def schema_graph(standard: str, schema: str) -> dict[str, dict] | None:
    """{element: {"children": [...], "attributes": [...]}} for one schema, or
    None when the standard has no cards or the schema has no element."""
    data = _cards_for(standard)
    if data is None or schema in _NON_DOCUMENT_SCHEMAS:
        return None
    if is_dita_standard(standard):
        return _dita_graph(data, schema) if schema in DITA_DOCUMENT_TYPES else None
    graph: dict[str, dict] = {}
    for name, variants in data.get("cards", {}).items():
        for variant in variants:
            if schema in variant.get("schemas", []):
                graph[name] = {
                    "children": list(variant.get("children", [])),
                    "attributes": [a["name"] for a in variant.get("attributes", [])],
                }
                break
    return graph or None


def _root_of(graph: dict[str, dict]) -> str:
    children = {c for entry in graph.values() for c in entry["children"]}
    roots = [n for n in graph if n not in children and n != "Description"]
    for known in DOCUMENT_ROOTS:
        if known in roots:
            return known
    return sorted(roots)[0]


def _path_to_para(
    graph: dict[str, dict],
    root: str,
    target: str = INSERTION_TARGET,
    excluded: frozenset = SKELETON_EXCLUDED,
) -> list[str] | None:
    # (cost, -structural containers, path)
    queue: list[tuple[int, int, list[str]]] = [(0, 0, [root])]
    best: dict[str, tuple[int, int]] = {}
    while queue:
        cost, structural, path = heapq.heappop(queue)
        node = path[-1]
        if node == target and len(path) > 1:
            return path
        if node in best and best[node] <= (cost, structural):
            continue
        best[node] = (cost, structural)
        if len(path) >= _MAX_DEPTH:
            continue
        for child in graph.get(node, {}).get("children", []):
            if child not in graph or child in path or child in excluded:
                continue
            step = 0 if child in STRUCTURAL_CONTAINERS else 1
            heapq.heappush(queue, (cost + step, structural - (1 if step == 0 else 0), path + [child]))
    return None


def _body_path(graph: dict[str, dict], root: str) -> tuple[list[str], str]:
    content = next(
        (c for c in graph[root]["children"] if c in graph and c.lower().endswith("content") and c not in SKELETON_EXCLUDED),
        None,
    )
    if content is None:
        return [root], "root"
    bodies = [c for c in graph[content]["children"] if c in graph and c not in SKELETON_EXCLUDED]
    if not bodies:
        return [root, content], "content"
    body = sorted(bodies, key=lambda c: (-len(graph[c]["children"]), c))[0]
    return [root, content, body], "body"


@lru_cache(maxsize=256)
def derive_skeleton(standard: str, schema: str) -> dict | None:
    """{"root", "path", "insertion", "derivation"} for one schema, or None.
    derivation: "para" (a chain down to <para>), or the fallback kind --
    "body", "content" or "root"."""
    graph = schema_graph(standard, schema)
    if graph is None:
        return None
    if is_dita_standard(standard):
        return _dita_skeleton(graph, schema)
    root = _root_of(graph)
    path = _path_to_para(graph, root)
    derivation = "para"
    if path is None:
        path, derivation = _body_path(graph, root)
    return {"root": root, "path": path, "insertion": path[-1], "derivation": derivation}


def _dita_skeleton(graph: dict[str, dict], root: str) -> dict:
    target = DITA_INSERTION_TARGET.get(root) or next(
        (c for c in graph[root]["children"] if c.endswith("body")), None
    )
    path = _path_to_para(graph, root, target, DITA_SKELETON_EXCLUDED) if target else None
    if path is None:
        return {"root": root, "path": [root], "insertion": root, "derivation": "root"}
    return {"root": root, "path": path, "insertion": path[-1], "derivation": "body" if target != "step" else "step"}


def get_element_schemas(standard: str, names: list[str]) -> dict[str, list[str]]:
    """DITA: for each name, the topic types whose graph has it (the client
    picks the type of a general rule's examples from this). {} for any other
    standard -- there the card variants already list their schemas."""
    if not is_dita_standard(standard):
        return {}
    graphs = {t: schema_graph(standard, t) or {} for t in DITA_DOCUMENT_TYPES}
    return {name: [t for t in DITA_DOCUMENT_TYPES if name in graphs[t]] for name in names}


def get_schema_structure(standard: str, schema: str) -> dict:
    """The compact structure the Test rule panel needs for one schema: the
    derived skeleton plus every element's children and attribute names
    (names only -- no enums, no truncation: the structural check needs the
    complete lists)."""
    graph = schema_graph(standard, schema)
    skeleton = derive_skeleton(standard, schema)
    if graph is None or skeleton is None:
        return {"standard": standard, "schema": schema, "available": False, "skeleton": None, "elements": {}}
    return {"standard": standard, "schema": schema, "available": True, "skeleton": skeleton, "elements": graph}
