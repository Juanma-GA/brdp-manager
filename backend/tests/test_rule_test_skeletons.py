"""Test rule (T2b): the per-schema skeletons are derived from the real schema
cards and every link of every skeleton is a real parent/child pair of that
schema; GET /api/schema-cards/structure serves them with the schema's
complete element graph."""
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import User
from app.services.rule_test_skeletons import (
    DITA_NESTED_TYPES,
    DITA_SKELETON_EXCLUDED,
    SKELETON_EXCLUDED,
    derive_skeleton,
    get_element_schemas,
    schema_graph,
)
from app.services.schema_cards import get_document_schemas

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
