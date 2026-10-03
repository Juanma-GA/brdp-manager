"""Consolidation C2, Part 0: what is saved as a rule must contain a rule of
the project's format.

Unit tests of app.services.rule_format_check (the table of edge cases, for
every format) and the route defense: PUT …/approvals/{format} answers 422
with the reason. The interface runs the same check first
(checkRuleFormat in src/validation/schemaValidation.js, tested by
scripts/test-schema-validation.mjs with the same cases).
"""

import uuid

import pytest
from lxml import etree

from app.api.routes.approvals import _wrap_rule_xml_fragment
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole
from app.services.rule_format_check import check_rule_format

RULE_42 = (
    '<structureObjectRule id="BRDP-X-1"><objectPath allowedObjectFlag="0">//emphasis</objectPath>'
    "<objectUse>No emphasis.</objectUse></structureObjectRule>"
)
NON_CONTEXT_42 = '<nonContextRule id="BRDP-X-2"><simplePara>Follow the style guide.</simplePara></nonContextRule>'
CONTEXT_42 = (
    '<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">'
    f"<structureObjectRuleGroup>{RULE_42}</structureObjectRuleGroup></contextRules>"
)
RULE_301 = '<objrule id="BRDP-X-3"><objpath objappl="0">//emphasis</objpath><objuse>No emphasis.</objuse></objrule>'
PATTERN_DITA = (
    '<sch:pattern id="p1"><sch:rule context="note"><sch:assert id="a1" test="@type">Type.</sch:assert></sch:rule></sch:pattern>'
)


def _check(xml: str, fmt: str) -> dict | None:
    return check_rule_format(etree.fromstring(_wrap_rule_xml_fragment(xml).encode("utf-8")), fmt)


@pytest.mark.parametrize(
    "xml, fmt",
    [
        (RULE_42, "BREX-4.2"),
        (NON_CONTEXT_42, "BREX-4.2"),  # only a nonContextRule is valid BREX
        (CONTEXT_42, "BREX-4.2"),
        (f"{RULE_42}{CONTEXT_42}", "BREX-4.2"),  # loose rule + context block (BRDP-S1-00006 shape)
        (f"<!-- note -->{RULE_42}", "BREX-4.2"),  # comments next to the rule are fine
        (RULE_42, "BREX-4.1"),
        (RULE_301, "BREX-3.0.1"),
        ('<!-- nonContextRule id="BRDP-X-4": follow the guide -->', "BREX-3.0.1"),
        (
            '<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/descript.xsd">'
            f"<structrules>{RULE_301}</structrules></contextrules>",
            "BREX-3.0.1",
        ),
        (PATTERN_DITA, "SCH-DITA"),
        ('<pattern><rule context="note"><assert test="@type">T</assert></rule></pattern>', "SCH-DITA"),
        ('<sch:rule context="note"><sch:assert test="@type">T</sch:assert></sch:rule>', "SCH-DITA"),
        ("<anything/>", "FAKE-FORMAT"),  # unknown format: not checked
    ],
)
def test_rules_of_the_format_are_accepted(xml, fmt):
    assert _check(xml, fmt) is None


@pytest.mark.parametrize(
    "xml, fmt, code, message",
    [
        # The real case: escaped text only, no element.
        ("//&lt;emphasis&gt;", "BREX-4.2", "rule_format_missing", "This is not a BREX 4.2 rule: structureObjectRule is missing"),
        ("", "BREX-4.2", "rule_format_missing", "This is not a BREX 4.2 rule: structureObjectRule is missing"),
        ("<!-- just a comment -->", "BREX-4.2", "rule_format_missing", "This is not a BREX 4.2 rule: structureObjectRule is missing"),
        (
            PATTERN_DITA,
            "BREX-4.2",
            "rule_format_other_format",
            "<sch:pattern> belongs to a Schematron (DITA) rule, not to a BREX 4.2 rule",
        ),
        (
            f"<rules>{RULE_42}{NON_CONTEXT_42}</rules>",
            "BREX-4.2",
            "rule_format_wrapper",
            "<rules> is not allowed around the rule: write structureObjectRule directly",
        ),
        (
            f"<structureObjectRuleGroup>{RULE_42}</structureObjectRuleGroup>",
            "BREX-4.2",
            "rule_format_wrapper",
            "<structureObjectRuleGroup> is not allowed around the rule: write structureObjectRule directly",
        ),
        (
            '<contextRules rulesContext="x.xsd"><structureObjectRuleGroup/></contextRules>',
            "BREX-4.2",
            "rule_format_empty_block",
            "<contextRules> contains no structureObjectRule",
        ),
        ("<dmodule/>", "BREX-4.2", "rule_format_foreign", "<dmodule> is not part of a BREX 4.2 rule"),
        (
            f"{RULE_42} extra words",
            "BREX-4.2",
            "rule_format_text",
            "Loose text outside the rule element is not allowed: “extra words”",
        ),
        (RULE_42, "BREX-3.0.1", "rule_format_other_format", "<structureObjectRule> belongs to a BREX 4.x rule, not to a BREX 3.0.1 rule"),
        (RULE_301, "BREX-4.2", "rule_format_other_format", "<objrule> belongs to a BREX 3.0.1 rule, not to a BREX 4.2 rule"),
        (RULE_42, "SCH-DITA", "rule_format_other_format", "<structureObjectRule> belongs to a BREX 4.x rule, not to a Schematron (DITA) rule"),
        ("<!-- a plain comment -->", "BREX-3.0.1", "rule_format_missing", "This is not a BREX 3.0.1 rule: objrule is missing"),
        ("//note", "SCH-DITA", "rule_format_missing", "This is not a Schematron (DITA) rule: sch:pattern is missing"),
    ],
)
def test_content_that_is_not_a_rule_of_the_format_is_reported(xml, fmt, code, message):
    problem = _check(xml, fmt)
    assert problem is not None
    assert problem["code"] == code
    assert problem["message"] == message


@pytest.fixture
async def editor_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"Rule Format Project {uuid.uuid4()}", standard="S1000D 4.2")
        user = User(
            email=f"rule-format-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Rule Format Editor",
            global_role="user",
        )
        session.add_all([project, user])
        await session.flush()
        session.add(UserProjectRole(user_id=user.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(user)
    yield project, {"Authorization": f"Bearer {create_access_token(user.id)}"}
    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        db_user = await session.get(User, user.id)
        if db_user is not None:
            await session.delete(db_user)
        await session.commit()


async def test_put_rejects_content_that_is_not_a_rule_with_422_and_the_reason(client, editor_and_project):
    project, headers = editor_and_project
    brdp = (await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-FMT-1"}, headers=headers)).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2"

    loose = await client.put(url, json={"rule_xml": "//&lt;emphasis&gt;", "source": "external_llm"}, headers=headers)
    assert loose.status_code == 422
    assert loose.json()["detail"] == "This is not a BREX 4.2 rule: structureObjectRule is missing"

    wrapped = await client.put(url, json={"rule_xml": f"<rules>{RULE_42}</rules>", "source": "manual"}, headers=headers)
    assert wrapped.status_code == 422
    assert "<rules> is not allowed around the rule" in wrapped.json()["detail"]

    schematron = await client.put(url, json={"rule_xml": PATTERN_DITA, "source": "manual"}, headers=headers)
    assert schematron.status_code == 422
    assert "Schematron (DITA)" in schematron.json()["detail"]

    # Nothing was saved by the rejected calls.
    assert (await client.get(url, headers=headers)).json() is None

    for good in (RULE_42, NON_CONTEXT_42, CONTEXT_42):
        ok = await client.put(url, json={"rule_xml": good, "source": "manual"}, headers=headers)
        assert ok.status_code == 200
        assert ok.json()["rule_xml"] == good
