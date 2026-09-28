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
from app.services.schema_cards import (
    MAX_ATTRIBUTES,
    MAX_CHILDREN,
    MAX_ENUM_VALUES,
    MAX_PARENTS,
    STANDARD_TO_SCHEMA_CARDS_FILE,
    _CARDS_BY_FILE,
    _collapse_enum_to_ranges,
)


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
        assert len(entry["parents"]) <= MAX_PARENTS
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


# "Pulido de fichas" round, point 1: unit tests for the pure range-collapsing
# helper -- the literal cases the encargo names (cv01..cv99, 01..99, gaps,
# non-numeric) plus the edge cases that determine whether it bails out at all.
class TestCollapseEnumToRanges:
    def test_full_consecutive_run_with_alpha_prefix(self):
        values = [f"cv{n:02d}" for n in range(1, 100)]
        assert _collapse_enum_to_ranges(values) == ["cv01–cv99"]

    def test_full_consecutive_run_with_no_prefix(self):
        values = [f"{n:02d}" for n in range(1, 100)]
        assert _collapse_enum_to_ranges(values) == ["01–99"]

    def test_gap_produces_two_ranges(self):
        values = [f"cv{n:02d}" for n in range(1, 21)] + [f"cv{n:02d}" for n in range(51, 100)]
        assert _collapse_enum_to_ranges(values) == ["cv01–cv20", "cv51–cv99"]

    def test_non_numeric_values_never_collapse(self):
        assert _collapse_enum_to_ranges(["add", "delete", "modify"]) is None

    def test_mixed_digit_width_never_collapses(self):
        assert _collapse_enum_to_ranges(["cv1", "cv02"]) is None

    def test_mixed_prefix_never_collapses(self):
        assert _collapse_enum_to_ranges(["cv01", "sc02"]) is None

    def test_single_value_stays_a_single_token_no_dash(self):
        assert _collapse_enum_to_ranges(["cv01"]) == ["cv01"]

    def test_two_consecutive_values_collapse_to_one_range(self):
        assert _collapse_enum_to_ranges(["cv01", "cv02"]) == ["cv01–cv02"]

    def test_two_non_consecutive_values_stay_two_tokens(self):
        assert _collapse_enum_to_ranges(["cv01", "cv05"]) == ["cv01", "cv05"]

    def test_unordered_input_is_sorted_before_grouping(self):
        assert _collapse_enum_to_ranges(["cv03", "cv01", "cv02"]) == ["cv01–cv03"]

    def test_duplicate_values_are_deduped_not_rejected(self):
        assert _collapse_enum_to_ranges(["cv01", "cv01", "cv02"]) == ["cv01–cv02"]

    def test_empty_list_returns_none(self):
        assert _collapse_enum_to_ranges([]) is None


@pytest.mark.asyncio
async def test_para_caveat_and_security_classification_render_as_ranges(client):
    """Real data (docs request's own edge case): <para> in S1000D 4.2 has
    @caveat (cv01..cv99) and @securityClassification (01..99), both a
    clean 99-value consecutive sequence -- collapsed to a single range
    token each, never truncated (a range represents the complete list by
    construction, so truncation would be actively wrong here). @changeType
    (add/delete/modify) is NOT a numeric sequence, so it must render
    completely unchanged -- confirms the collapsing is selective, not a
    blanket reformat of every enum."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "para"}, headers=_headers(user)
    )
    assert res.status_code == 200
    variant = res.json()["cards"]["para"]["variants"][0]
    attrs = {a["name"]: a for a in variant["attributes"]}

    assert attrs["caveat"]["enum"] == ["cv01–cv99"]
    assert attrs["caveat"]["enum_truncated"] is False
    assert attrs["securityClassification"]["enum"] == ["01–99"]
    assert attrs["securityClassification"]["enum_truncated"] is False
    assert attrs["changeType"]["enum"] == ["add", "delete", "modify"]
    assert attrs["changeType"]["enum_truncated"] is False


@pytest.mark.asyncio
async def test_short_consecutive_enum_stays_a_plain_list_not_a_range(client):
    """"Ajustes al juego de pruebas de prompts" round, Part 4: a short
    consecutive-numeric enum reads better as a plain list than as a range
    token -- the collapsing mechanism above exists for cv01..cv99-shaped
    enums (99 near-identical values), not for objectPath's real
    allowedObjectFlag (0/1/2, confirmed against schema-cards-4-2.json),
    which is exactly the kind of short enum the previous round's blanket
    collapse wrongly turned into "0–2". len(enum) <= MAX_ENUM_VALUES must
    leave it exactly as the generator produced it, uncollapsed."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "objectPath"}, headers=_headers(user)
    )
    assert res.status_code == 200
    variant = res.json()["cards"]["objectPath"]["variants"][0]
    attrs = {a["name"]: a for a in variant["attributes"]}
    assert attrs["allowedObjectFlag"]["enum"] == ["0", "1", "2"]
    assert attrs["allowedObjectFlag"]["enum_truncated"] is False


@pytest.mark.asyncio
async def test_long_consecutive_enum_still_collapses_to_a_range(client):
    """"Ajustes al juego de pruebas de prompts" round, Part 4, other half of
    the same gate: an enum long enough to actually need it (more than
    MAX_ENUM_VALUES=20 values) must still collapse -- the gating in Part 4
    only turns the mechanism OFF for short enums, it must never turn it off
    altogether. Reuses <para>'s real @caveat (S1000D 3.0.1 this time, not
    4.2 -- confirmed against schema-cards-3-0-1.json: 99 values, cv01..cv99,
    same shape as 4.2's) as real data genuinely over the threshold."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 3.0.1", "names": "para"}, headers=_headers(user)
    )
    assert res.status_code == 200
    variant = res.json()["cards"]["para"]["variants"][0]
    attrs = {a["name"]: a for a in variant["attributes"]}
    assert attrs["caveat"]["enum"] == ["cv01–cv99"]
    assert attrs["caveat"]["enum_truncated"] is False


@pytest.mark.asyncio
async def test_para_real_43_parents_fit_under_max_parents_untruncated(client):
    """"Did you mean con marcado a medias y listas de padres cortadas"
    round, Part 2, the encargo's own worked example: <para> in S1000D 4.2
    really does have 43 parents (confirmed by counting
    backend/schema_cards/schema-cards-4-2.json directly before picking 60)
    -- just over the OLD MAX_CHILDREN=40 cutoff that used to also gate
    parents, so a real "Where can <para> go?" answer always hit "+3 more"
    even though 43 is still a short, readable list. Under the new, separate
    MAX_PARENTS=60 the full 43 must come back untruncated."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "para"}, headers=_headers(user)
    )
    assert res.status_code == 200
    entry = res.json()["cards"]["para"]
    assert len(entry["parents"]) == 43
    assert entry["parents_truncated"] is False
    assert entry["parents_omitted"] == 0


@pytest.mark.asyncio
async def test_refs_real_152_parents_still_truncate_at_max_parents(client):
    """Other half of the same gate: MAX_PARENTS=60 is a real cap, not
    "never truncate parents again" -- `refs` in S1000D 4.2 has 152 real
    parents (confirmed by counting the same generated file), the encargo's
    own second worked example ("refs en 4.2 (152) -> partial list: 60 of
    152 shown"). It must still come back capped at exactly 60, flagged."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "refs"}, headers=_headers(user)
    )
    assert res.status_code == 200
    entry = res.json()["cards"]["refs"]
    assert len(entry["parents"]) == MAX_PARENTS
    assert entry["parents_truncated"] is True
    assert entry["parents_omitted"] == 152 - MAX_PARENTS


def test_real_per_standard_parents_truncation_counts_match_the_documented_table():
    """Locks in the exact counts schema_cards.py's own MAX_PARENTS comment
    cites as justification for picking 60 over 40 -- computed directly from
    the real generated cards files (no server, no fixtures), so this fails
    loudly if the schema data is ever regenerated in a way that silently
    changes the tradeoff the comment describes."""
    expected = {
        "S1000D 3.0.1": (4, 4),
        "S1000D 4.1": (7, 5),
        "S1000D 4.2": (8, 5),
        "DITA 1.3 Xpath2.0": (137, 60),
    }
    for standard, (expected_over_40, expected_over_60) in expected.items():
        filename = STANDARD_TO_SCHEMA_CARDS_FILE[standard]
        data = _CARDS_BY_FILE[filename]
        parents = data.get("parents", {})
        over_40 = sum(1 for names in parents.values() if len(names) > 40)
        over_60 = sum(1 for names in parents.values() if len(names) > MAX_PARENTS)
        assert over_40 == expected_over_40, f"{standard}: expected {expected_over_40} elements over 40 parents, got {over_40}"
        assert over_60 == expected_over_60, f"{standard}: expected {expected_over_60} elements over 60 parents, got {over_60}"
    # <para>'s own real parent count, the encargo's worked example, cross-
    # checked against the raw (pre-compaction) data too -- confirms the
    # HTTP-level test above isn't accidentally passing because of some
    # compaction-layer artifact.
    para_parents = _CARDS_BY_FILE[STANDARD_TO_SCHEMA_CARDS_FILE["S1000D 4.2"]]["parents"]["para"]
    assert len(para_parents) == 43


@pytest.mark.asyncio
async def test_document_schemas_lists_the_rule_context_variants(client):
    """Suggest Rule part 2: every document-type schema of the standard,
    without the imported helper schemas (dc/rdf/xlink/xcf), so the client
    can tell whether an element exists in all of them."""
    user = await _make_user()
    expected = {
        "S1000D 4.2": 28,
        "S1000D 4.1": 26,
        "S1000D 3.0.1": 19,
    }
    for standard, count in expected.items():
        res = await client.get(
            "/api/schema-cards", params={"standard": standard, "names": "emphasis"}, headers=_headers(user)
        )
        schemas = res.json()["document_schemas"]
        assert len(schemas) == count, standard
        assert {"proced", "descript", "fault", "ipd"} <= set(schemas)
        assert not {"dc", "rdf", "xlink", "xcf"} & set(schemas)
        assert schemas == sorted(schemas)
    assert "checklist" not in (
        await client.get(
            "/api/schema-cards", params={"standard": "S1000D 3.0.1", "names": "para"}, headers=_headers(user)
        )
    ).json()["document_schemas"]
    # <emphasis> exists in every 4.2 document schema -> no schema choice needed
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "emphasis"}, headers=_headers(user)
    )
    body = res.json()
    covered = {s for v in body["cards"]["emphasis"]["variants"] for s in v["schemas"]}
    assert set(body["document_schemas"]) <= covered
    unavailable = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 5.0", "names": "para"}, headers=_headers(user)
    )
    assert unavailable.json()["document_schemas"] == []


# ─── C1, Part 2: full cards and attribute owners (Ask's deterministic
# structural answers) ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_full_cards_cut_no_list(client):
    """full=true: every child, attribute and parent is returned -- a
    structural answer lists them all. <refs> (S1000D 4.2) has 152 real parents,
    cut to MAX_PARENTS without `full`."""
    user = await _make_user()
    data = _CARDS_BY_FILE[STANDARD_TO_SCHEMA_CARDS_FILE["S1000D 4.2"]]
    name = "refs"
    real_parents = data["parents"][name]
    assert len(real_parents) > MAX_PARENTS
    cut = await client.get("/api/schema-cards", params={"standard": "S1000D 4.2", "names": name}, headers=_headers(user))
    full = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": name, "full": "true"}, headers=_headers(user)
    )
    assert cut.json()["cards"][name]["parents_truncated"] is True
    card = full.json()["cards"][name]
    assert card["parents"] == real_parents and card["parents_truncated"] is False and card["parents_omitted"] == 0
    for variant in card["variants"]:
        assert variant["children_truncated"] is False and variant["attributes_truncated"] is False
        assert all(not a["enum_truncated"] for a in variant["attributes"])


@pytest.mark.asyncio
async def test_full_cards_keep_long_enums_as_ranges(client):
    """A long clean sequence still collapses (lossless): @caveat of <para>
    in S1000D 4.2 is cv01–cv99 with or without `full`."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards", params={"standard": "S1000D 4.2", "names": "para", "full": "true"}, headers=_headers(user)
    )
    variant = res.json()["cards"]["para"]["variants"][0]
    caveat = next(a for a in variant["attributes"] if a["name"] == "caveat")
    assert caveat["enum"] == ["cv01–cv99"]


@pytest.mark.asyncio
async def test_attribute_owners_with_complete_values(client):
    """@emphasisType in S1000D 4.2 is declared only by <emphasis>, em01–em99
    in every schema variant; @frame only by <table>."""
    user = await _make_user()
    res = await client.get(
        "/api/schema-cards/attribute", params={"standard": "S1000D 4.2", "name": "emphasisType"}, headers=_headers(user)
    )
    body = res.json()
    assert res.status_code == 200 and body["available"] is True
    assert {o["element"] for o in body["owners"]} == {"emphasis"}
    assert all(o["enum"] == ["em01–em99"] for o in body["owners"])
    frame = await client.get(
        "/api/schema-cards/attribute", params={"standard": "S1000D 4.2", "name": "frame"}, headers=_headers(user)
    )
    owners = frame.json()["owners"]
    assert {o["element"] for o in owners} == {"table"}
    assert owners[0]["enum"] == ["top", "bottom", "topbot", "all", "sides", "none"]


@pytest.mark.asyncio
async def test_attribute_owners_unknown_and_unavailable(client):
    user = await _make_user()
    unknown = await client.get(
        "/api/schema-cards/attribute", params={"standard": "S1000D 4.2", "name": "pokemon"}, headers=_headers(user)
    )
    assert unknown.json() == {"standard": "S1000D 4.2", "name": "pokemon", "available": True, "owners": []}
    missing = await client.get(
        "/api/schema-cards/attribute", params={"standard": "S1000D 5.0", "name": "frame"}, headers=_headers(user)
    )
    assert missing.json()["available"] is False and missing.json()["owners"] == []
    no_auth = await client.get("/api/schema-cards/attribute", params={"standard": "S1000D 4.2", "name": "frame"})
    assert no_auth.status_code == 401
