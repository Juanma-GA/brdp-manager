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
          for map. A topic's mandatory <title> is listed in "titled" (T4b):
          the client writes it as the root's first child.

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
# Topic types whose <title> is mandatory (T4b); a map's title is optional.
DITA_TITLED_TYPES = frozenset({"topic", "concept", "task", "reference", "troubleshooting"})


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
    return {"root": root, "path": path, "insertion": path[-1], "derivation": derivation, "titled": []}


def _dita_skeleton(graph: dict[str, dict], root: str) -> dict:
    target = DITA_INSERTION_TARGET.get(root) or next(
        (c for c in graph[root]["children"] if c.endswith("body")), None
    )
    path = _path_to_para(graph, root, target, DITA_SKELETON_EXCLUDED) if target else None
    # T4b: a DITA topic's <title> is mandatory (a map's is optional), so the
    # skeleton gives the root its title -- only when the root really takes
    # one in its graph.
    titled = [root] if root in DITA_TITLED_TYPES and "title" in graph[root]["children"] else []
    if path is None:
        return {"root": root, "path": [root], "insertion": root, "derivation": "root", "titled": titled}
    derivation = "body" if target != "step" else "step"
    return {"root": root, "path": path, "insertion": path[-1], "derivation": derivation, "titled": titled}


# ─── The identification and status section (rule test on DM metadata) ──────
# The examples used to be built only inside <content>, so a rule about a data
# module's metadata (//dmIdent/dmCode/@infoCode, //dmStatus/@issueType,
# //responsiblePartnerCompany/@enterpriseCode, …) never had anything to look
# at and the test ended "inconclusive". Every assembled data module now
# carries a minimal, valid identification and status section.
#
# The cards list each element's children but not their minOccurs, so the
# elements of the minimal section are fixed here (the XSD's required ones,
# in the XSD's order: 4.x identAndStatusSection/dmAddress/dmStatus, 3.0.1
# idstatus/dmaddres/status) together with the text of the elements that have
# some. Everything else comes from the cards and is checked against them for
# every schema (_metadata_tree): each child must be allowed in its parent,
# each REQUIRED attribute of the card is added -- its value from
# METADATA_ATTRIBUTE_VALUES, or the enum's first value -- and no optional
# attribute is (minimal). A schema whose cards do not fit the template gets no
# section (None), never an invalid one; backend/tests/test_rule_test_skeletons.py
# also validates every section against the real XSD.
#
# Node: (name, {attribute: value} overrides, text or None, [children]).
_METADATA_TEMPLATE_4X = (
    "identAndStatusSection", {}, None, [
        ("dmAddress", {}, None, [
            ("dmIdent", {}, None, [
                ("dmCode", {}, None, []),
                ("language", {}, None, []),
                ("issueInfo", {}, None, []),
            ]),
            ("dmAddressItems", {}, None, [
                ("issueDate", {}, None, []),
                ("dmTitle", {}, None, [("techName", {}, "Example data module", [])]),
            ]),
        ]),
        ("dmStatus", {}, None, [
            ("security", {}, None, []),
            ("responsiblePartnerCompany", {}, None, [("enterpriseName", {}, "Example company", [])]),
            ("originator", {}, None, [("enterpriseName", {}, "Example company", [])]),
            ("applic", {}, None, [("displayText", {}, None, [("simplePara", {}, "All", [])])]),
            ("brexDmRef", {}, None, [
                ("dmRef", {}, None, [
                    ("dmRefIdent", {}, None, [
                        # The project's own BREX (info code 022), with the
                        # same neutral values as the data module's code: a
                        # rule on a code attribute (//@assyCode[…]) sees the
                        # same kind of value in both dmCodes.
                        ("dmCode", {"infoCode": "022", "itemLocationCode": "D"}, None, []),
                    ]),
                ]),
            ]),
            ("qualityAssurance", {}, None, [("unverified", {}, None, [])]),
        ]),
    ],
)

# 3.0.1 writes the data module code as elements with text.
def _avee_301(values: dict[str, str]) -> tuple:
    order = ["modelic", "sdc", "chapnum", "section", "subsect", "subject", "discode", "discodev", "incode", "incodev", "itemloc"]
    return ("avee", {}, None, [(name, {}, values[name], []) for name in order])


_METADATA_TEMPLATE_301 = (
    "idstatus", {}, None, [
        ("dmaddres", {}, None, [
            ("dmc", {}, None, [_avee_301({
                "modelic": "EXAMPLE", "sdc": "A", "chapnum": "00", "section": "0", "subsect": "0",
                "subject": "00", "discode": "00", "discodev": "A", "incode": "040", "incodev": "A", "itemloc": "A",
            })]),
            ("dmtitle", {}, None, [("techname", {}, "Example data module", [])]),
            ("issno", {}, None, []),
            ("issdate", {}, None, []),
            ("language", {"country": "US"}, None, []),
        ]),
        ("status", {}, None, [
            ("security", {}, None, []),
            ("rpc", {}, "Example company", []),
            ("orig", {}, "Example company", []),
            ("applic", {}, None, [("displaytext", {}, None, [("p", {}, "All", [])])]),
            ("brexref", {}, None, [
                ("refdm", {}, None, [_avee_301({
                    # The project's own BREX (info code 022), see 4.x.
                    "modelic": "EXAMPLE", "sdc": "A", "chapnum": "00", "section": "0", "subsect": "0",
                    "subject": "00", "discode": "00", "discodev": "A", "incode": "022", "incodev": "A", "itemloc": "D",
                })]),
            ]),
            ("qa", {}, None, [("unverif", {}, None, [])]),
        ]),
    ],
)

# 4.x data update file (update.xsd, root dataUpdateFile): the same idea for
# its updateIdentAndStatusSection -- the update's own address (updateCode,
# where @infoCode tells which CIR the file updates: 00N tools, …), its status
# (source data module, target issue, the project's BREX) and the status of
# the target data module. Added for the curated template's tool-CIR rule
# (BRDP-EXT-00019, //updateCode[@infoCode='00N']): without it no example can
# say which CIR it is.
_DM_CODE_BREX = ("dmCode", {"infoCode": "022", "itemLocationCode": "D"}, None, [])
_BREX_DM_REF_4X = ("brexDmRef", {}, None, [("dmRef", {}, None, [("dmRefIdent", {}, None, [_DM_CODE_BREX])])])
_METADATA_TEMPLATE_UPDATE_4X = (
    "updateIdentAndStatusSection", {}, None, [
        ("updateAddress", {}, None, [
            ("updateIdent", {}, None, [
                ("updateCode", {"objectIdentCode": "DMC"}, None, []),
                ("language", {}, None, []),
                ("issueInfo", {}, None, []),
            ]),
            ("issueDate", {}, None, []),
        ]),
        ("updateStatus", {}, None, [
            ("sourceDmIdent", {}, None, [
                ("dmCode", {}, None, []),
                ("language", {}, None, []),
                ("issueInfo", {}, None, []),
            ]),
            ("targetDmIssueInfo", {}, None, []),
            ("responsiblePartnerCompany", {}, None, [("enterpriseName", {}, "Example company", [])]),
            ("originator", {}, None, [("enterpriseName", {}, "Example company", [])]),
            _BREX_DM_REF_4X,
            ("qualityAssurance", {}, None, [("unverified", {}, None, [])]),
        ]),
        ("targetDmStatus", {}, None, [
            ("security", {}, None, []),
            ("responsiblePartnerCompany", {}, None, [("enterpriseName", {}, "Example company", [])]),
            ("originator", {}, None, [("enterpriseName", {}, "Example company", [])]),
            ("applic", {}, None, [("displayText", {}, None, [("simplePara", {}, "All", [])])]),
            _BREX_DM_REF_4X,
            ("qualityAssurance", {}, None, [("unverified", {}, None, [])]),
        ]),
    ],
)

# 4.x publication module (pm.xsd), data dispatch note (ddn.xsd) and data
# management list (dml.xsd): each has its own identAndStatusSection
# (pmAddress/pmStatus, ddnAddress/ddnStatus, dmlAddress/dmlStatus), with the
# XSD's required elements in the XSD's order. A rule on a publication
# module's applicability (//pmStatus/applicRef, BRDP-EXT-00029 of Official
# Default CMP ATA 4.2) had no section to look at: Mistral put <pmStatus>
# inside <content>.
_METADATA_TEMPLATE_PM_4X = (
    "identAndStatusSection", {}, None, [
        ("pmAddress", {}, None, [
            ("pmIdent", {}, None, [
                ("pmCode", {}, None, []),
                ("language", {}, None, []),
                ("issueInfo", {}, None, []),
            ]),
            ("pmAddressItems", {}, None, [
                ("issueDate", {}, None, []),
                ("pmTitle", {}, "Example publication module", []),
            ]),
        ]),
        ("pmStatus", {}, None, [
            ("security", {}, None, []),
            ("responsiblePartnerCompany", {}, None, [("enterpriseName", {}, "Example company", [])]),
            ("originator", {}, None, [("enterpriseName", {}, "Example company", [])]),
            ("applic", {}, None, [("displayText", {}, None, [("simplePara", {}, "All", [])])]),
            _BREX_DM_REF_4X,
            ("qualityAssurance", {}, None, [("unverified", {}, None, [])]),
        ]),
    ],
)

_DISPATCH_ADDRESS_4X = ("dispatchAddress", {}, None, [
    ("enterprise", {}, None, [("enterpriseName", {}, "Example company", [])]),
    ("address", {}, None, [("city", {}, "Example city", []), ("country", {}, "Example country", [])]),
])
_METADATA_TEMPLATE_DDN_4X = (
    "identAndStatusSection", {}, None, [
        ("ddnAddress", {}, None, [
            ("ddnIdent", {}, None, [("ddnCode", {}, None, [])]),
            ("ddnAddressItems", {}, None, [
                ("issueDate", {}, None, []),
                ("dispatchTo", {}, None, [_DISPATCH_ADDRESS_4X]),
                ("dispatchFrom", {}, None, [_DISPATCH_ADDRESS_4X]),
            ]),
        ]),
        ("ddnStatus", {}, None, [
            ("security", {}, None, []),
            ("authorization", {}, "Example authorization", []),
            _BREX_DM_REF_4X,
        ]),
    ],
)

_METADATA_TEMPLATE_DML_4X = (
    "identAndStatusSection", {}, None, [
        ("dmlAddress", {}, None, [
            ("dmlIdent", {}, None, [("dmlCode", {}, None, []), ("issueInfo", {}, None, [])]),
            ("dmlAddressItems", {}, None, [("issueDate", {}, None, [])]),
        ]),
        ("dmlStatus", {}, None, [
            ("security", {}, None, []),
            _BREX_DM_REF_4X,
        ]),
    ],
)

# 3.0.1 publication module: idstatus with pmaddres (the code as elements
# with text, like the data module's avee) and pmstatus -- which has no
# reference to the BREX in 3.0.1. 3.0.1 ddn and dml have no section at all
# (ddnc, issdate, dispto… and dmlc, issno… sit directly in the root), so
# there is nothing to add there: the examples' content goes in the root.
_METADATA_TEMPLATE_PM_301 = (
    "idstatus", {}, None, [
        ("pmaddres", {}, None, [
            ("pmc", {}, None, [
                ("modelic", {}, "EXAMPLE", []),
                ("pmissuer", {}, "12345", []),
                ("pmnumber", {}, "00001", []),
                ("pmvolume", {}, "00", []),
            ]),
            ("pmtitle", {}, "Example publication module", []),
            ("issno", {}, None, []),
            ("issdate", {}, None, []),
            ("language", {"country": "US"}, None, []),
        ]),
        ("pmstatus", {}, None, [
            ("security", {}, None, []),
            ("rpc", {}, "Example company", []),
            ("orig", {}, "Example company", []),
            ("applic", {}, None, [("displaytext", {}, None, [("p", {}, "All", [])])]),
            ("qa", {}, None, [("unverif", {}, None, [])]),
        ]),
    ],
)

# Values of the required attributes that have no enum (keyed by attribute
# name; the XSD patterns they must follow are checked by the tests).
METADATA_ATTRIBUTE_VALUES = {
    # 4.x dmCode of the example data module
    "modelIdentCode": "EXAMPLE", "systemDiffCode": "A", "systemCode": "00", "subSystemCode": "0",
    "subSubSystemCode": "0", "assyCode": "00", "disassyCode": "00", "disassyCodeVariant": "A",
    "infoCode": "040", "infoCodeVariant": "A",
    # 4.x language, issueInfo
    "languageIsoCode": "en", "countryIsoCode": "US", "issueNumber": "001", "inWork": "00",
    # 3.0.1 issno, language
    "issno": "001", "language": "en",
    # issueDate / issdate
    "year": "2026", "month": "01", "day": "01",
    # 4.x pmCode, ddnCode, dmlCode ([A-Z0-9]{5}, \d{2}, [0-9]{4}, [0-9]{5})
    "pmIssuer": "12345", "pmNumber": "00001", "pmVolume": "00",
    "senderIdent": "SENDR", "receiverIdent": "RECVR", "yearOfDataIssue": "2026", "seqNumber": "00001",
}

# The templates of each document root, tried in order: the first whose
# section element is a child of the root (4.x identAndStatusSection, 3.0.1
# idstatus). pm, ddn and dml share the element name identAndStatusSection
# with the data module, so the templates are keyed by root, not by element.
# Not covered yet (no section): comment, scormContentPackage,
# icnMetadataFile -- the Test rule panel does not offer those schemas to a
# rule that looks at their section (ruleTestSkeleton.js, sectionMissing).
METADATA_TEMPLATES_BY_ROOT = {
    "dmodule": (_METADATA_TEMPLATE_4X, _METADATA_TEMPLATE_301),
    "dataUpdateFile": (_METADATA_TEMPLATE_UPDATE_4X,),
    "pm": (_METADATA_TEMPLATE_PM_4X, _METADATA_TEMPLATE_PM_301),
    "ddn": (_METADATA_TEMPLATE_DDN_4X,),
    "dml": (_METADATA_TEMPLATE_DML_4X,),
}


def _card_variant(cards: dict, name: str, schema: str) -> dict | None:
    for variant in cards.get(name, []):
        if schema in variant.get("schemas", []):
            return variant
    return None


def _metadata_tree(cards: dict, graph: dict[str, dict], schema: str, node: tuple, parent: str | None) -> dict | None:
    name, overrides, text, children = node
    variant = _card_variant(cards, name, schema)
    if variant is None or name not in graph:
        return None
    if parent is not None and name not in graph[parent]["children"]:
        return None
    declared = {a["name"]: a for a in variant.get("attributes", [])}
    attributes = []
    for attr in variant.get("attributes", []):
        if not attr.get("required") and attr["name"] not in overrides:
            continue
        value = overrides.get(attr["name"], METADATA_ATTRIBUTE_VALUES.get(attr["name"]))
        if value is None and attr.get("enum"):
            value = attr["enum"][0]
        if value is None:
            return None
        if attr.get("enum") and value not in attr["enum"]:
            return None
        attributes.append([attr["name"], value])
    if any(a not in declared for a in overrides):
        return None
    out_children = []
    for child in children:
        built = _metadata_tree(cards, graph, schema, child, name)
        if built is None:
            return None
        out_children.append(built)
    # Attributes in card order (alphabetical): their order carries no meaning.
    return {"name": name, "attributes": attributes, "text": text, "children": out_children}


@lru_cache(maxsize=256)
def derive_metadata_skeleton(standard: str, schema: str) -> dict | None:
    """{"element", "tree"} -- the minimal identification and status section of
    a data module schema, of the 4.x data update file, of a publication
    module (4.x and 3.0.1) or of a 4.x DDN or DML (see above) -- or None:
    DITA, another document (comment, …, and the 3.0.1 ddn/dml, which have no
    section), or cards that do not fit the template."""
    if is_dita_standard(standard):
        return None
    graph = schema_graph(standard, schema)
    data = _cards_for(standard)
    if graph is None or data is None:
        return None
    root = _root_of(graph)
    for template in METADATA_TEMPLATES_BY_ROOT.get(root, ()):
        element = template[0]
        if element in graph[root]["children"]:
            tree = _metadata_tree(data.get("cards", {}), graph, schema, template, root)
            return {"element": element, "tree": tree} if tree else None
    return None


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
    skeleton = {**skeleton, "metadata": derive_metadata_skeleton(standard, schema)}
    return {"standard": standard, "schema": schema, "available": True, "skeleton": skeleton, "elements": graph}


# Consolidation C2, Part 3: Ask's yes/no question "can <parent> contain
# <child>?" answered from the cards. The answer is about the DIRECT relation,
# schema by schema (the parent card's variants list their schemas and their
# direct children); when a schema has no direct relation, the shortest chain
# of elements that does reach the child is given as an example (breadth
# first over that schema's whole graph -- finite, so "not reachable" is a
# real answer, never a depth limit), so the answer can say "not directly".


def _dita_full_graph(data: dict) -> dict[str, list[str]]:
    return {name: list(variants[0].get("children", [])) for name, variants in data.get("cards", {}).items() if variants}


def _shortest_path(children_of, start: str, target: str) -> list[str] | None:
    previous = {start: None}
    frontier = [start]
    while frontier:
        nxt = []
        for node in frontier:
            for child in children_of(node):
                if child == target:
                    path = [child, node]
                    while previous[path[-1]] is not None:
                        path.append(previous[path[-1]])
                    return list(reversed(path))
                if child not in previous:
                    previous[child] = node
                    nxt.append(child)
        frontier = nxt
    return None


def get_element_relation(standard: str, parent: str, child: str) -> dict:
    """{"available", "parent_exists", "child_exists", "schemas": [{"schema",
    "direct", "path"}]} -- one entry per document schema where `parent` is
    defined (DITA: the single merged "DITA 1.3" schema of its cards).
    `path` (parent … child, shortest) only when the relation is not direct
    and the child is reachable through other elements; else None."""
    data = _cards_for(standard)
    if data is None:
        return {"available": False, "parent_exists": False, "child_exists": False, "schemas": []}
    cards = data.get("cards", {})
    result = {"available": True, "parent_exists": parent in cards, "child_exists": child in cards, "schemas": []}
    if parent not in cards or child not in cards:
        return result
    dita_graph = _dita_full_graph(data) if is_dita_standard(standard) else None
    for variant in cards[parent]:
        direct = child in variant.get("children", [])
        for schema in variant.get("schemas", []):
            if schema in _NON_DOCUMENT_SCHEMAS:
                continue
            path = None
            if not direct:
                if dita_graph is not None:
                    path = _shortest_path(lambda n: dita_graph.get(n, []), parent, child)
                else:
                    graph = schema_graph(standard, schema) or {}
                    path = _shortest_path(lambda n, g=graph: g.get(n, {}).get("children", []), parent, child)
            result["schemas"].append({"schema": schema, "direct": direct, "path": path})
    result["schemas"].sort(key=lambda s: s["schema"])
    return result
