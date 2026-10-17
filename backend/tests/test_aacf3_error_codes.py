"""AACF 3, Part 3 (HR15/HR21, Decisión 12): the errors a user meets in
normal use come back as `{code, ...params, message}`.

The interface translates `code` (errors.codes.<code>, EN and ES); the
English `message` stays next to it for scripts and older readers. One
request per code that is not already checked elsewhere (the Excel, AI
Extract, Papelera restore, duplicate identifier, import, last-admin and
own-account codes are asserted in their own test files).

Real Postgres, no mocking.
"""
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, Project, User, UserProjectRole

PASSWORD = "Error-codes-pw-123"


def _headers(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.fixture
async def world():
    async with async_session_factory() as session:
        project = Project(name=f"Error codes {uuid.uuid4()}", standard="S1000D 4.2")
        admin = User(
            email=f"codes-admin-{uuid.uuid4()}@example.com",
            password_hash=hash_password(PASSWORD),
            display_name="codes admin",
            global_role="admin",
        )
        session.add_all([project, admin])
        await session.flush()
        brdp = BRDP(project_id=project.id, identifier="BRDP-CODES-001", title="T")
        session.add_all([brdp, UserProjectRole(user_id=admin.id, project_id=project.id, role="editor")])
        await session.commit()
        await session.refresh(project)
        await session.refresh(admin)
        await session.refresh(brdp)
    yield project, admin, brdp
    async with async_session_factory() as session:
        await session.delete(await session.get(Project, project.id))
        await session.delete(await session.get(User, admin.id))
        await session.commit()


def _detail(response, status, code):
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == code, detail
    assert detail["message"], "the English message stays next to the code"
    return detail


async def test_missing_brdp_is_coded(client, world):
    project, admin, _brdp = world
    missing = uuid.uuid4()
    res = await client.put(f"/api/projects/{project.id}/brdps/{missing}", json={"title": "x"}, headers=_headers(admin))
    _detail(res, 404, "brdp_not_found")
    res = await client.post(f"/api/projects/{project.id}/embeddings/brdps/{missing}", headers=_headers(admin))
    _detail(res, 404, "brdp_not_found")


async def test_missing_rule_and_trashed_brdp_are_coded(client, world):
    project, admin, brdp = world
    res = await client.post(
        f"/api/projects/{project.id}/brdps/{brdp.id}/approvals/BREX-4.2/test",
        json={"result": "passed", "rule_hash": "0" * 64},
        headers=_headers(admin),
    )
    _detail(res, 404, "rule_not_found")
    res = await client.post(f"/api/trash/{uuid.uuid4()}/restore", headers=_headers(admin))
    _detail(res, 404, "trashed_brdp_not_found")


async def test_outdated_rule_test_is_coded(client, world):
    project, admin, brdp = world
    rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>x</objectUse></structureObjectRule>'
    saved = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp.id}/approvals/BREX-4.2",
        json={"rule_xml": rule, "status": "pending_review", "source": "manual"},
        headers=_headers(admin),
    )
    assert saved.status_code == 200, saved.text
    res = await client.post(
        f"/api/projects/{project.id}/brdps/{brdp.id}/approvals/BREX-4.2/test",
        json={"result": "passed", "rule_hash": "0" * 64},
        headers=_headers(admin),
    )
    _detail(res, 409, "rule_test_outdated")


async def test_user_errors_are_coded(client, world):
    _project, admin, _brdp = world
    res = await client.post(f"/api/users/{uuid.uuid4()}/reset-password", headers=_headers(admin))
    _detail(res, 404, "user_not_found")
    res = await client.post(
        "/api/users",
        json={"email": admin.email, "display_name": "dup", "global_role": "user"},
        headers=_headers(admin),
    )
    detail = _detail(res, 409, "user_email_registered")
    assert detail["email"] == admin.email
    res = await client.post(
        "/api/auth/change-password",
        json={"current_password": "not-the-password", "new_password": "Another-pw-12345"},
        headers=_headers(admin),
    )
    _detail(res, 403, "current_password_incorrect")
