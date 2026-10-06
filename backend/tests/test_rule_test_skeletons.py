"""Test rule (T2b): the per-schema skeletons are derived from the real schema
cards and every link of every skeleton is a real parent/child pair of that
schema; GET /api/schema-cards/structure serves them with the schema's
complete element graph."""
import uuid
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

import pytest
from lxml import etree

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import User
from app.services.rule_test_skeletons import (
    DITA_NESTED_TYPES,
    DITA_SKELETON_EXCLUDED,
    SKELETON_EXCLUDED,
    derive_metadata_skeleton,
    derive_skeleton,
    get_element_schemas,
    schema_content_models,
    schema_graph,
)
from app.services.schema_cards import _CARDS_BY_FILE, STANDARD_TO_SCHEMA_CARDS_FILE, get_document_schemas

S1000D = ["S1000D 4.2", "S1000D 4.1", "S1000D 3.0.1"]
DITA = ["DITA 1.3 Xpath2.0", "DITA 1.3 Xpath3.0"]


async def _make_user() -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"skeleton-test-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Skeleton Test User",
            global_role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.mark.parametrize("standard", S1000D + DITA)
def test_every_skeleton_link_is_a_real_parent_child_pair(standard):
    schemas = get_document_schemas(standard)
    assert schemas, standard
    for schema in schemas:
        graph = schema_graph(standard, schema)
        skeleton = derive_skeleton(standard, schema)
        assert skeleton is not None, schema
        path = skeleton["path"]
        assert path[0] == skeleton["root"]
        assert path[-1] == skeleton["insertion"]
        # The root has no parent in its own schema.
        assert all(path[0] not in entry["children"] for entry in graph.values()), (standard, schema)
        for parent, child in zip(path, path[1:]):
            assert child in graph, (standard, schema, child)
            assert child in graph[parent]["children"], (standard, schema, parent, child)
            assert child not in (DITA_SKELETON_EXCLUDED if standard in DITA else SKELETON_EXCLUDED)
        if skeleton["derivation"] == "para":
            assert skeleton["insertion"] == "para"
        elif skeleton["derivation"] == "step":
            assert skeleton["insertion"] == "step"
        else:
            assert skeleton["derivation"] in {"body", "content", "root"}


@pytest.mark.parametrize(
    "standard,schema,expected",
    [
        ("S1000D 4.2", "descript", "dmodule/content/description/levelledPara/para"),
        ("S1000D 4.2", "proced", "dmodule/content/procedure/mainProcedure/proceduralStep/para"),
        ("S1000D 4.1", "descript", "dmodule/content/description/levelledPara/para"),
        ("S1000D 4.1", "proced", "dmodule/content/procedure/mainProcedure/proceduralStep/para"),
        ("S1000D 3.0.1", "descript", "dmodule/content/descript/para0/para"),
        ("S1000D 3.0.1", "proced", "dmodule/content/proced/mainfunc/step1/para"),
        ("S1000D 4.2", "ipd", "dmodule/content/illustratedPartsCatalog"),
        ("S1000D 4.2", "pm", "pm/content/pmEntry"),
        ("S1000D 3.0.1", "dml", "dml"),
        # DITA (T4): one skeleton per topic type.
        ("DITA 1.3 Xpath2.0", "topic", "topic/body"),
        ("DITA 1.3 Xpath2.0", "concept", "concept/conbody"),
        ("DITA 1.3 Xpath2.0", "task", "task/taskbody/steps/step"),
        ("DITA 1.3 Xpath3.0", "reference", "reference/refbody"),
        ("DITA 1.3 Xpath3.0", "troubleshooting", "troubleshooting/troublebody"),
        ("DITA 1.3 Xpath3.0", "map", "map"),
    ],
)
def test_known_skeletons(standard, schema, expected):
    assert "/".join(derive_skeleton(standard, schema)["path"]) == expected


def test_dita_types_are_the_document_schemas_and_never_nest_other_types():
    assert get_document_schemas("DITA 1.3 Xpath2.0") == ["topic", "concept", "task", "reference", "troubleshooting", "map"]
    for schema in get_document_schemas("DITA 1.3 Xpath2.0"):
        graph = schema_graph("DITA 1.3 Xpath2.0", schema)
        # Another topic/map type is another document, never part of this graph.
        assert not (set(graph) - {schema}) & DITA_NESTED_TYPES, schema
        assert all(c in graph for entry in graph.values() for c in entry["children"]), schema
    # T4b: topics carry their mandatory <title>; a map's is optional.
    for schema in ("topic", "concept", "task", "reference", "troubleshooting"):
        assert derive_skeleton("DITA 1.3 Xpath2.0", schema)["titled"] == [schema]
    assert derive_skeleton("DITA 1.3 Xpath2.0", "map")["titled"] == []
    assert derive_skeleton("S1000D 4.2", "descript")["titled"] == []
    # The merged "DITA 1.3" schema itself is not a test schema.
    assert derive_skeleton("DITA 1.3 Xpath2.0", "DITA 1.3") is None


def test_dita_element_schemas_by_reachability():
    found = get_element_schemas("DITA 1.3 Xpath3.0", ["step", "cmd", "topicref", "note", "nosuch"])
    assert found["step"][0] == "task" and "topic" not in found["step"]
    assert "concept" not in found["cmd"]
    assert found["topicref"] == ["map"]
    assert found["note"][0] == "topic"
    assert found["nosuch"] == []
    assert get_element_schemas("S1000D 4.2", ["para"]) == {}


def test_no_skeleton_for_helper_schemas_or_standards_without_cards():
    assert derive_skeleton("S1000D 4.2", "xlink") is None
    assert derive_skeleton("S1000D 4.2", "nosuchschema") is None
    assert derive_skeleton("S1000D 5.0", "descript") is None


@pytest.mark.asyncio
async def test_structure_endpoint_serves_skeleton_and_complete_graph(client):
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards/structure", params={"standard": "S1000D 4.2", "schema": "proced"}, headers=_headers(user)
    )
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is True
    assert body["schema_name"] == "proced"
    assert body["skeleton"]["insertion"] == "para"
    elements = body["elements"]
    assert "para" in elements["proceduralStep"]["children"]
    assert "emphasis" in elements["para"]["children"]
    assert "emphasisType" in elements["emphasis"]["attributes"]
    # The cases of the first real run: <step> is not an S1000D 4.2 element,
    # and <warning> does not take <content> nor @emphasisType.
    assert "step" not in elements
    assert "content" not in elements["warning"]["children"]
    assert "emphasisType" not in elements["warning"]["attributes"]
    # No truncation: <para> has more than MAX_CHILDREN (40) children in no
    # schema, but the attribute lists are complete (securityClassification
    # sits past index 10).
    assert "securityClassification" in elements["para"]["attributes"]


@pytest.mark.asyncio
async def test_structure_and_cards_endpoints_for_dita(client):
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards/structure", params={"standard": "DITA 1.3 Xpath2.0", "schema": "task"}, headers=_headers(user)
    )
    body = res.json()
    assert body["available"] is True
    assert body["skeleton"]["path"] == ["task", "taskbody", "steps", "step"]
    assert body["skeleton"]["titled"] == ["task"]
    assert "cmd" in body["elements"]["step"]["children"]
    assert "type" in body["elements"]["note"]["attributes"]
    res = await client.get(
        "/api/schema-cards", params={"standard": "DITA 1.3 Xpath2.0", "names": "step,note"}, headers=_headers(user)
    )
    body = res.json()
    assert body["document_schemas"][0] == "topic"
    assert body["element_schemas"]["step"][0] == "task"
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "para"}, headers=_headers(user)
    )
    assert res.json()["element_schemas"] == {}


@pytest.mark.asyncio
async def test_structure_endpoint_unavailable_and_auth(client):
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards/structure", params={"standard": "S1000D 5.0", "schema": "descript"}, headers=_headers(user)
    )
    assert res.status_code == 200
    assert res.json()["available"] is False
    assert res.json()["skeleton"] is None
    res = await client.get("/api/schema-cards/structure", params={"standard": "S1000D 4.2", "schema": "proced"})
    assert res.status_code == 401


# ─── The identification and status section (rule test on DM metadata) ──────
XSD_DIRS = {
    "S1000D 4.2": "4.2",
    "S1000D 4.1": "4.1",
    "S1000D 3.0.1": "3.0.1",
}
SOURCES = Path(__file__).resolve().parents[2] / "sources" / "SchemasS1000D"


def _serialize(node: dict) -> str:
    """Same serialization as ruleTestSkeleton.js's metadataXml (no
    indentation here: the XSD check does not care)."""
    attrs = "".join(f" {name}={quoteattr(value)}" for name, value in node["attributes"])
    inner = escape(node["text"] or "") + "".join(_serialize(c) for c in node["children"])
    return f"<{node['name']}{attrs}>{inner}</{node['name']}>" if inner else f"<{node['name']}{attrs}/>"


def _nodes(node: dict):
    yield node
    for child in node["children"]:
        yield from _nodes(child)


@pytest.mark.parametrize("standard", S1000D)
def test_every_data_module_schema_has_a_metadata_section_that_fits_its_cards(standard):
    cards = _CARDS_BY_FILE[STANDARD_TO_SCHEMA_CARDS_FILE[standard]]["cards"]
    covered = []
    for schema in get_document_schemas(standard):
        skeleton = derive_skeleton(standard, schema)
        metadata = derive_metadata_skeleton(standard, schema)
        covered_roots = ("dmodule", "dataUpdateFile", "pm") + (("ddn", "dml") if standard != "S1000D 3.0.1" else ())
        if skeleton["root"] not in covered_roots:
            # comment, scormContentPackage, icnMetadataFile: not covered yet;
            # the 3.0.1 ddn and dml have no section at all.
            assert metadata is None, (standard, schema)
            continue
        assert metadata is not None, (standard, schema)
        covered.append(schema)
        graph = schema_graph(standard, schema)
        tree = metadata["tree"]
        assert tree["name"] == metadata["element"]
        assert metadata["element"] in graph[skeleton["root"]]["children"]
        for node in _nodes(tree):
            variant = next(v for v in cards[node["name"]] if schema in v["schemas"])
            declared = {a["name"]: a for a in variant["attributes"]}
            names = [name for name, _ in node["attributes"]]
            # every required attribute of the card, and only declared ones
            assert {a for a, d in declared.items() if d.get("required")} <= set(names), (schema, node["name"])
            for name, value in node["attributes"]:
                assert name in declared, (schema, node["name"], name)
                if declared[name].get("enum"):
                    assert value in declared[name]["enum"], (schema, node["name"], name, value)
            for child in node["children"]:
                assert child["name"] in graph[node["name"]]["children"], (schema, node["name"], child["name"])
    assert "descript" in covered and "proced" in covered and "pm" in covered
    if standard != "S1000D 3.0.1":
        assert "ddn" in covered and "dml" in covered


@pytest.mark.parametrize("standard", S1000D)
def test_every_metadata_section_is_valid_against_the_real_xsd(standard):
    for schema in get_document_schemas(standard):
        metadata = derive_metadata_skeleton(standard, schema)
        if metadata is None:
            continue
        # The content of the skeleton alone may be incomplete for the XSD (a
        # <description> needs more than one empty <para>): only the errors
        # inside the identification and status section count.
        path = derive_skeleton(standard, schema)["path"]
        root = path[0]
        body = "".join(f"<{n}>" for n in path[1:]) + "".join(f"</{n}>" for n in reversed(path[1:]))
        doc = f"<{root}>{_serialize(metadata['tree'])}{body}</{root}>"
        xsd = etree.XMLSchema(etree.parse(str(SOURCES / XSD_DIRS[standard] / f"{schema}.xsd")))
        xsd.validate(etree.fromstring(doc))
        section = f"/{root}/{metadata['element']}"
        errors = [e.message for e in xsd.error_log if (e.path or "").startswith(section)]
        assert errors == [], (standard, schema, errors)


def test_known_metadata_sections():
    tree = derive_metadata_skeleton("S1000D 4.2", "descript")["tree"]
    assert [c["name"] for c in tree["children"]] == ["dmAddress", "dmStatus"]
    dm_status = tree["children"][1]
    assert [c["name"] for c in dm_status["children"]] == [
        "security", "responsiblePartnerCompany", "originator", "applic", "brexDmRef", "qualityAssurance",
    ]
    dm_code = tree["children"][0]["children"][0]["children"][0]
    assert dm_code["name"] == "dmCode"
    assert dict(dm_code["attributes"])["infoCode"] == "040"
    # Minimal: no optional attribute (no @issueType on dmStatus, no
    # @enterpriseCode on responsiblePartnerCompany).
    assert dm_status["attributes"] == []
    assert dm_status["children"][1]["attributes"] == []
    tree301 = derive_metadata_skeleton("S1000D 3.0.1", "descript")["tree"]
    assert tree301["name"] == "idstatus"
    assert [c["name"] for c in tree301["children"][1]["children"]] == ["security", "rpc", "orig", "applic", "brexref", "qa"]
    # pm, ddn and dml: their own sections (EXT-00029 of CMP ATA looks at
    # //pmStatus/applic…). 3.0.1: the pm's idstatus; ddn and dml have none.
    for standard in ("S1000D 4.1", "S1000D 4.2"):
        pm = derive_metadata_skeleton(standard, "pm")
        assert pm["element"] == "identAndStatusSection"
        assert [c["name"] for c in pm["tree"]["children"]] == ["pmAddress", "pmStatus"]
        assert [c["name"] for c in pm["tree"]["children"][1]["children"]] == [
            "security", "responsiblePartnerCompany", "originator", "applic", "brexDmRef", "qualityAssurance",
        ]
        pm_code = pm["tree"]["children"][0]["children"][0]["children"][0]
        assert pm_code["name"] == "pmCode" and dict(pm_code["attributes"])["modelIdentCode"] == "EXAMPLE"
        ddn = derive_metadata_skeleton(standard, "ddn")
        assert [c["name"] for c in ddn["tree"]["children"]] == ["ddnAddress", "ddnStatus"]
        assert [c["name"] for c in ddn["tree"]["children"][1]["children"]] == ["security", "authorization", "brexDmRef"]
        dml = derive_metadata_skeleton(standard, "dml")
        assert [c["name"] for c in dml["tree"]["children"]] == ["dmlAddress", "dmlStatus"]
        assert [c["name"] for c in dml["tree"]["children"][1]["children"]] == ["security", "brexDmRef"]
        assert derive_metadata_skeleton(standard, "comment") is None
    pm301 = derive_metadata_skeleton("S1000D 3.0.1", "pm")
    assert pm301["element"] == "idstatus"
    assert [c["name"] for c in pm301["tree"]["children"]] == ["pmaddres", "pmstatus"]
    assert [c["name"] for c in pm301["tree"]["children"][1]["children"]] == ["security", "rpc", "orig", "applic", "qa"]
    assert derive_metadata_skeleton("S1000D 3.0.1", "ddn") is None
    assert derive_metadata_skeleton("S1000D 3.0.1", "dml") is None
    # 4.x data update file: its own section, with the update's code (the
    # curated template's tool-CIR rule looks at //updateCode/@infoCode).
    for standard in ("S1000D 4.1", "S1000D 4.2"):
        update = derive_metadata_skeleton(standard, "update")
        assert update["element"] == "updateIdentAndStatusSection"
        assert [c["name"] for c in update["tree"]["children"]] == ["updateAddress", "updateStatus", "targetDmStatus"]
        update_code = update["tree"]["children"][0]["children"][0]["children"][0]
        assert update_code["name"] == "updateCode"
        assert dict(update_code["attributes"])["infoCode"] == "040"
    assert derive_metadata_skeleton("S1000D 3.0.1", "update") is None
    assert derive_metadata_skeleton("DITA 1.3 Xpath2.0", "topic") is None
    assert derive_metadata_skeleton("S1000D 5.0", "descript") is None


@pytest.mark.asyncio
async def test_structure_endpoint_serves_the_metadata_section(client):
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards/structure", params={"standard": "S1000D 4.2", "schema": "descript"}, headers=_headers(user)
    )
    metadata = res.json()["skeleton"]["metadata"]
    assert metadata["element"] == "identAndStatusSection"
    assert metadata["tree"]["children"][0]["name"] == "dmAddress"
    res = await client.get(
        "/api/schema-cards/structure", params={"standard": "DITA 1.3 Xpath2.0", "schema": "task"}, headers=_headers(user)
    )
    assert res.json()["skeleton"]["metadata"] is None


# ─── Content models (ruta del esquema) ──────────────────────────────────────
# backend/schema_cards/content-models-*.json (generate_content_models.py):
# child order, required children and text per element, served in the
# structure so the client can build a valid chain down to an element.


@pytest.mark.parametrize("standard", S1000D)
def test_every_metadata_section_has_every_required_child_in_order(standard):
    """The minimal sections are validated against the real XSD above; the
    content models must agree with them: every required child (one of a
    required choice) is there, and the children follow the model's order."""
    for schema in get_document_schemas(standard):
        metadata = derive_metadata_skeleton(standard, schema)
        if metadata is None:
            continue
        models = schema_content_models(standard, schema)
        for node in _nodes(metadata["tree"]):
            model = models[node["name"]]
            names = [c["name"] for c in node["children"]]
            for slot in model["required"]:
                options = slot if isinstance(slot, list) else [slot]
                assert any(o in names for o in options), (standard, schema, node["name"], slot)
            positions = [model["order"].index(n) for n in names]
            assert positions == sorted(positions), (standard, schema, node["name"], names)
            assert {a for a, _ in node["attributes"]} >= {a for a, _ in model["attributes"]}, (standard, schema, node["name"])


def test_known_content_models():
    m = schema_content_models("S1000D 4.2", "descript")
    assert m["dmStatus"]["order"].index("dataRestrictions") == m["dmStatus"]["order"].index("security") + 2
    assert m["dmStatus"]["required"] == [
        "security", "responsiblePartnerCompany", "originator", ["applic", "applicRef"], "brexDmRef", "qualityAssurance",
    ]
    assert m["dataRestrictions"]["required"] == ["restrictionInstructions"]
    assert m["restrictionInstructions"]["required"] == ["dataDistribution"]
    assert m["restrictionInfo"]["required"] == []
    assert m["copyright"]["required"] == ["copyrightPara"]
    assert m["dataDistribution"]["text"] is True and m["dataRestrictions"]["text"] is False
    assert ["issueNumber", "001"] in m["issueInfo"]["attributes"]
    # 3.0.1: <copyright> lives in status/datarest/inform
    m301 = schema_content_models("S1000D 3.0.1", "descript")
    assert m301["datarest"]["required"] == ["instruct"] and m301["inform"]["required"] == ["copyright"]
    assert "datarest" in m301["status"]["order"]
    # DITA: one merged model, kept to the topic type's graph
    task = schema_content_models("DITA 1.3 Xpath2.0", "task")
    assert task["steps"]["required"] == ["step"]
    assert schema_content_models("S1000D 5.0", "descript") == {}


@pytest.mark.parametrize("standard,key,directory", [("S1000D 3.0.1", "3-0-1", "3.0.1"), ("S1000D 4.2", "4-2", "4.2")])
def test_content_models_file_matches_the_xsds(standard, key, directory):
    """The committed file is what the generator makes from the XSDs today."""
    import importlib.util
    import json

    spec = importlib.util.spec_from_file_location(
        "generate_content_models", Path(__file__).resolve().parents[1] / "scripts" / "generate_content_models.py"
    )
    module = importlib.util.module_from_spec(spec)
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    spec.loader.exec_module(module)
    built = module.build_models(module.build_scopes(SOURCES / directory, "isolated"))
    stored = json.loads((Path(__file__).resolve().parents[1] / "schema_cards" / f"content-models-{key}.json").read_text(encoding="utf-8"))
    assert built["unresolved_count"] == 0
    assert built["models"] == stored["models"]


@pytest.mark.asyncio
async def test_structure_endpoint_serves_the_content_models(client):
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards/structure", params={"standard": "S1000D 4.2", "schema": "descript"}, headers=_headers(user)
    )
    models = res.json()["models"]
    assert models["dataRestrictions"] == {
        "order": ["restrictionInstructions", "restrictionInfo"],
        "required": ["restrictionInstructions"],
        "text": False,
        "attributes": [],
    }
    assert models["dmStatus"]["required"][3] == ["applic", "applicRef"]
    res = await client.get(
        "/api/schema-cards/structure", params={"standard": "S1000D 5.0", "schema": "descript"}, headers=_headers(user)
    )
    assert res.json()["models"] == {}
