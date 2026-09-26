"""GET /api/schema-cards (docs request, "Servicio de fichas de esquema"):
compact structural facts for requested element names, backed by the real
generated cards under backend/schema_cards/*.json (loaded once at import
time by app.services.schema_cards -- these tests exercise the SAME loaded
data the running app uses, not a mock).
"""
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import User
from app.services.schema_cards import MAX_ATTRIBUTES, MAX_CHILDREN, MAX_ENUM_VALUES


async def _make_user() -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"schema-cards-test-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Schema Cards Test User",
            global_role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.mark.asyncio
async def test_real_element_returns_the_real_attributes_and_children(client):
    """<table> in S1000D 4.2 -- hand-verified against the real XSD
    (sources/SchemasS1000D/4.2/*.xsd): @frame is a closed enum of exactly
    top/bottom/topbot/all/sides/none, children are graphic/tgroup/title."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "table"}, headers=_headers(user)
    )
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is True
    assert body["unknown"] == []
    entry = body["cards"]["table"]
    variants = entry["variants"]
    assert len(variants) == 1
    variant = variants[0]
    assert variant["resolved"] is True
    assert set(variant["children"]) == {"graphic", "tgroup", "title"}
    frame = next(a for a in variant["attributes"] if a["name"] == "frame")
    assert frame["enum"] == ["top", "bottom", "topbot", "all", "sides", "none"]
    assert frame["required"] is False
    assert frame["enum_truncated"] is False
    # "allowed inside" -- the reverse index (docs request point 1). <table>
    # is a real S1000D block-level element usable inside commonInfoDescrPara
    # (confirmed by grep: content/commonInfoDescrPara's group ref chain
    # reaches table's containing choice) -- NOT plain <para>, which sits at
    # the same content level as <table> rather than containing it.
    assert "commonInfoDescrPara" in entry["parents"]


@pytest.mark.asyncio
async def test_element_with_genuinely_different_definitions_across_schemas_returns_multiple_variants(client):
    """<para> in S1000D 4.2 really does resolve differently depending on
    which document-type module declares it (e.g. process.xsd's para adds
    globalPropertyRef/variableRef, unique to that module) -- more than one
    variant, each naming which schema files share it."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "para"}, headers=_headers(user)
    )
    assert res.status_code == 200
    variants = res.json()["cards"]["para"]["variants"]
    assert len(variants) > 1
    all_schemas = [s for v in variants for s in v["schemas"]]
    assert len(all_schemas) == len(set(all_schemas))  # every schema file appears in exactly one variant
    process_variant = next(v for v in variants if "process" in v["schemas"])
    assert "globalPropertyRef" in process_variant["children"]


@pytest.mark.asyncio
async def test_unknown_name_is_reported_separately_never_as_an_error(client):
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "table,pokemon"}, headers=_headers(user)
    )
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is True
    assert "table" in body["cards"]
    assert body["unknown"] == ["pokemon"]
    assert "pokemon" not in body["cards"]


@pytest.mark.asyncio
async def test_standard_with_no_generated_cards_reports_not_available(client):
    """S1000D 5.0 has no schema in this repo at all -- explicit
    'not available', never a false empty result."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 5.0", "names": "table"}, headers=_headers(user)
    )
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is False
    assert body["cards"] == {}
    assert body["unknown"] == ["table"]


@pytest.mark.asyncio
async def test_both_dita_xpath_flavors_share_the_same_cards(client):
    user = await _make_user()
    res2 = await client.get(
        "/api/schema-cards", params={"standard": "DITA 1.3 Xpath2.0", "names": "table"}, headers=_headers(user)
    )
    res3 = await client.get(
        "/api/schema-cards", params={"standard": "DITA 1.3 Xpath3.0", "names": "table"}, headers=_headers(user)
    )
    assert res2.status_code == 200 and res3.status_code == 200
    assert res2.json()["cards"] == res3.json()["cards"]
    variant = res2.json()["cards"]["table"]["variants"][0]
    assert variant["schemas"] == ["DITA 1.3"]
    assert set(variant["children"]) == {"desc", "tgroup", "title"}


@pytest.mark.asyncio
async def test_dita_note_type_attribute_matches_the_real_closed_enum(client):
    """<note>'s @type in DITA 1.3 -- hand-verified against
    sources/D1.3/schema/base/xsd/commonElementMod.xsd's note.attributes
    group. <note>'s OWN content model (note.cnt) is unrelated to the
    redefined "note" domain-composition group used by OTHER elements'
    content models (confirmed by reading topicMod.xsd/commonElementMod.xsd
    directly) -- so <note> itself never contains <hazardstatement>; see
    the next test for where that redefine-driven addition actually shows up."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "DITA 1.3 Xpath2.0", "names": "note"}, headers=_headers(user)
    )
    assert res.status_code == 200
    variant = res.json()["cards"]["note"]["variants"][0]
    type_attr = next(a for a in variant["attributes"] if a["name"] == "type")
    assert set(type_attr["enum"]) >= {
        "attention", "caution", "danger", "fastpath", "important", "note", "notice",
        "other", "remember", "restriction", "tip", "trouble", "warning",
    }


@pytest.mark.asyncio
async def test_dita_redefine_self_reference_resolves_to_the_base_group_not_itself(client):
    """A real, deliberate redefine-driven cross-domain addition: every DITA
    topic shell (topic.xsd/concept.xsd/task.xsd/map.xsd/bookmap.xsd) merges
    hazard-d-note into the shared "note" group -- <p>'s content model uses
    that group directly (basic.block -> note), so <p> should allow BOTH
    <note> (the base group's own content, reached via the redefine's
    self-reference) and <hazardstatement> (the redefine's addition). A real
    bug here (lxml's Element.append() silently reparenting/emptying the
    live parsed document on a shared redefine body) made the base group's
    contribution vanish after the first element that used it -- this is
    the regression test for that fix."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "DITA 1.3 Xpath2.0", "names": "p,section,body"}, headers=_headers(user)
    )
    assert res.status_code == 200
    cards = res.json()["cards"]
    for name in ("p", "section", "body"):
        children = set(cards[name]["variants"][0]["children"])
        assert "note" in children, f"{name} should allow <note> (base group, via redefine self-ref)"
        assert "hazardstatement" in children, f"{name} should allow <hazardstatement> (redefine addition)"


@pytest.mark.asyncio
async def test_response_never_exceeds_the_documented_compact_limits(client):
    """dmCode-adjacent high-fanout elements exist in this schema (e.g.
    content/para variants have many attributes) -- rather than depend on
    finding a real element that happens to exceed the limits, this asserts
    the invariant holds for EVERY variant of EVERY element actually
    returned across a representative sweep, and that a real truncation (if
    any occurs) is always flagged, never silent."""
    user = await _make_user()
    # A broad sweep of real element names likely to have many
    # attributes/children in a full S1000D module (content wrappers).
    names = "content,identAndStatusSection,dmodule,para,title,table"
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": names}, headers=_headers(user)
    )
    assert res.status_code == 200
    body = res.json()
    for element_name, entry in body["cards"].items():
        assert len(entry["parents"]) <= MAX_CHILDREN
        if entry["parents_truncated"]:
            assert entry["parents_omitted"] > 0
        for variant in entry["variants"]:
            assert len(variant["attributes"]) <= MAX_ATTRIBUTES
            assert len(variant["children"]) <= MAX_CHILDREN
            if variant["attributes_truncated"]:
                assert variant["attributes_omitted"] > 0
            if variant["children_truncated"]:
                assert variant["children_omitted"] > 0
            for attr in variant["attributes"]:
                if attr["enum"]:
                    assert len(attr["enum"]) <= MAX_ENUM_VALUES
                if attr["enum_truncated"]:
                    assert attr["enum_omitted"] > 0


@pytest.mark.asyncio
async def test_requires_authentication(client):
    res = await client.get("/api/schema-cards", params={"standard": "S1000D 4.2", "names": "table"})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_duplicate_requested_names_are_deduped(client):
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "table,table,table"}, headers=_headers(user)
    )
    assert res.status_code == 200
    assert list(res.json()["cards"].keys()) == ["table"]
