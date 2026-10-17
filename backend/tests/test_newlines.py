"""Line endings of the text people type, paste or upload (Protecciones 1c).

A text written on Windows has CRLF, one from an old Mac a lone CR. Every
text that reaches a prompt or is compared literally is stored with LF only
(app/core/text.py): the BRDP texts, the Excel rows' texts, the free text of
AI Extract (its quotes are looked for in it, its paragraphs give the
identifiers). The rules are saved as written, like before: the UI sends LF
(a <textarea> gives LF on paste), and a rule saved with CRLF through the API
has another hash than the same rule with LF -- the last test then reads as
outdated, as after any other edit.

The free-text cases are in test_text_extract.py.
"""
import hashlib
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.core.text import normalize_newlines
from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole

RULE_LF = '<structureObjectRule id="BRDP-NL-001">\n  <objectPath allowedObjectFlag="0">//emphasis</objectPath>\n  <objectUse>No emphasis.</objectUse>\n</structureObjectRule>'


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@pytest.fixture
async def editor_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"Newlines {uuid.uuid4()}", standard="S1000D 4.2")
        user = User(email=f"nl-{uuid.uuid4()}@example.com", password_hash=hash_password("x"), display_name="NL", global_role="user")
        session.add_all([project, user])
        await session.flush()
        session.add(UserProjectRole(user_id=user.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(user)
    yield project, {"Authorization": f"Bearer {create_access_token(user.id)}"}
    async with async_session_factory() as session:
        for obj in (await session.get(Project, project.id), await session.get(User, user.id)):
            if obj is not None:
                await session.delete(obj)
        await session.commit()


def test_crlf_cr_and_mixed_line_endings_normalize_the_same():
    lf = "one\ntwo\n\nthree\n"
    assert normalize_newlines("one\r\ntwo\r\n\r\nthree\r\n") == lf
    assert normalize_newlines("one\rtwo\r\rthree\r") == lf
    assert normalize_newlines("one\r\ntwo\n\rthree\r") == lf
    assert normalize_newlines(lf) == lf
    # "\n\r" is two line breaks (LF, then a lone CR), never one.
    assert normalize_newlines("a\n\rb") == "a\n\nb"


async def test_brdp_texts_are_stored_with_lf(client, editor_and_project):
    project, headers = editor_and_project
    base = f"/api/projects/{project.id}/brdps"
    res = await client.post(
        base,
        headers=headers,
        json={"identifier": "BRDP-NL-001", "title": "Title\r\nline", "definition": "Def\rold Mac", "proposal": "A\r\nB\rC\nD", "comments": "x\r\ny"},
    )
    assert res.status_code == 201, res.text
    brdp = res.json()
    assert (brdp["title"], brdp["definition"], brdp["proposal"], brdp["comments"]) == ("Title\nline", "Def\nold Mac", "A\nB\nC\nD", "x\ny")
    res = await client.put(f"{base}/{brdp['id']}", headers=headers, json={"proposal": "New\r\nproposal", "validation": "Refused", "comments": "why\r\nnot"})
    assert res.status_code == 200, res.text
    assert (res.json()["proposal"], res.json()["comments"]) == ("New\nproposal", "why\nnot")
    # A null is still refused (the normalizer leaves non-strings alone).
    assert (await client.put(f"{base}/{brdp['id']}", headers=headers, json={"title": None})).status_code == 422


async def test_the_length_limit_counts_the_text_as_stored(client, editor_and_project, monkeypatch):
    """Normalized before max_length: a CRLF text that is at the limit once
    stored is accepted."""
    from app.core.config import get_settings

    project, headers = editor_and_project
    limit = get_settings().brdp_title_max_chars
    text = "a\r\n" * (limit // 2)  # limit chars with LF, more with CRLF
    assert len(text) > limit >= len(normalize_newlines(text))
    res = await client.post(f"/api/projects/{project.id}/brdps", headers=headers, json={"identifier": "BRDP-NL-LIM", "title": text})
    assert res.status_code == 201, res.text


async def test_excel_rows_with_crlf_are_unchanged_against_lf(client, editor_and_project):
    """The texts of an Excel row are compared with what is stored: the same
    words with other line endings are "unchanged"."""
    project, headers = editor_and_project
    base = f"/api/projects/{project.id}/brdps"
    await client.post(base, headers=headers, json={"identifier": "BRDP-NL-XL", "title": "T", "definition": "Line 1\nLine 2", "proposal": "P"})
    row = {"row_number": 2, "identifier": "BRDP-NL-XL", "title": "T", "definition": "Line 1\r\nLine 2", "proposal": "P", "proposal_status": "Pending", "rule_status": "To Do", "rule": ""}
    res = await client.post(f"{base}/import/analyze", headers=headers, json={"rows": [row]})
    assert res.status_code == 200, res.text
    (result,) = res.json()["results"]
    assert result["outcome"] == "ok" and result["unchanged"] is True, result


async def test_a_rule_is_saved_as_written_and_crlf_changes_its_hash(client, editor_and_project):
    """Rules are not normalized (saved and compared as before). The hash is
    over the saved bytes: the same rule with CRLF is another hash, so a test
    recorded on the LF version reads as outdated."""
    project, headers = editor_and_project
    brdp = (await client.post(f"/api/projects/{project.id}/brdps", headers=headers, json={"identifier": "BRDP-NL-001"})).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2"
    assert (await client.put(url, headers=headers, json={"rule_xml": RULE_LF, "source": "manual"})).status_code == 200
    body = (await client.post(url + "/test", headers=headers, json={"result": "passed", "rule_hash": _hash(RULE_LF)})).json()
    assert body["last_test_up_to_date"] is True
    rule_crlf = RULE_LF.replace("\n", "\r\n")
    body = (await client.put(url, headers=headers, json={"rule_xml": rule_crlf, "source": "manual"})).json()
    assert body["rule_xml"] == rule_crlf
    assert _hash(rule_crlf) != _hash(RULE_LF)
    assert body["last_test_up_to_date"] is False
