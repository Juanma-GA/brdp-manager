"""Project management: create (already existed, just exercised here for
completeness), rename, and delete -- the new deterministic project
management endpoints. Real Postgres, no mocking. Authorization for these
(editor for rename, admin for delete) is covered separately in
test_authorization.py's axis-(b) section; this file is functional
correctness -- does the operation actually do what it claims.
"""
import uuid

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, Note, Project, RuleApproval, SuggestionFeedback, User, UserProjectRole


async def _make_user(global_role: str = "user") -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"proj-test-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Project Test User",
            global_role=global_role,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _make_project(standard: str = "BREX — S1000D 4.2") -> Project:
    async with async_session_factory() as session:
        project = Project(name=f"Project Test {uuid.uuid4()}", standard=standard)
        session.add(project)
        await session.commit()
        await session.refresh(project)
        return project


async def _assign_role(user_id: uuid.UUID, project_id: uuid.UUID, role: str) -> None:
    async with async_session_factory() as session:
        session.add(UserProjectRole(user_id=user_id, project_id=project_id, role=role))
        await session.commit()


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _cleanup_user(user: User) -> None:
    async with async_session_factory() as session:
        db_user = await session.get(User, user.id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def test_rename_updates_name_but_never_standard(client):
    project = await _make_project(standard="BREX — S1000D 3.0.1")
    editor = await _make_user()
    await _assign_role(editor.id, project.id, "editor")
    try:
        response = await client.patch(
            f"/api/projects/{project.id}", json={"name": "Renamed Project"}, headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["name"] == "Renamed Project"
        assert body["standard"] == "BREX — S1000D 3.0.1"  # untouched

        async with async_session_factory() as session:
            db_project = await session.get(Project, project.id)
            assert db_project.name == "Renamed Project"
            assert db_project.standard == "BREX — S1000D 3.0.1"
    finally:
        async with async_session_factory() as session:
            db_project = await session.get(Project, project.id)
            if db_project is not None:
                await session.delete(db_project)
            await session.commit()
        await _cleanup_user(editor)


async def test_rename_rejects_a_standard_field_if_sent(client):
    """The schema has no `standard` field at all -- sending one is just
    ignored (extra fields), not silently applied. Belt-and-suspenders
    check that standard truly cannot be changed through this endpoint.
    """
    project = await _make_project(standard="BREX — S1000D 4.1")
    editor = await _make_user()
    await _assign_role(editor.id, project.id, "editor")
    try:
        response = await client.patch(
            f"/api/projects/{project.id}",
            json={"name": "Still Renamed", "standard": "BREX — S1000D 4.2"},
            headers=_headers(editor),
        )
        assert response.status_code == 200
        assert response.json()["standard"] == "BREX — S1000D 4.1"
    finally:
        async with async_session_factory() as session:
            db_project = await session.get(Project, project.id)
            if db_project is not None:
                await session.delete(db_project)
            await session.commit()
        await _cleanup_user(editor)


async def test_delete_cascades_to_brdps_notes_approvals_and_feedback(client):
    """The real point of this test: query Postgres directly afterward for
    every child table, not just trust the 204 -- and confirm a SEPARATE
    project's data survives untouched.
    """
    admin = await _make_user(global_role="admin")
    project = await _make_project()
    other_project = await _make_project()

    async with async_session_factory() as session:
        brdp = BRDP(project_id=project.id, identifier="BRDP-DEL-001", definition="d", proposal="p")
        other_brdp = BRDP(project_id=other_project.id, identifier="BRDP-KEEP-001", definition="d", proposal="p")
        session.add_all([brdp, other_brdp])
        await session.flush()
        session.add(Note(brdp_id=brdp.id, text="a note"))
        session.add(RuleApproval(brdp_id=brdp.id, format="BREX-4.2", rule_xml="<x/>", status="approved"))
        session.add(
            SuggestionFeedback(brdp_id=brdp.id, kind="definition", suggested_text="s", outcome="discarded")
        )
        session.add(Note(brdp_id=other_brdp.id, text="keep me"))
        await session.commit()
        await session.refresh(brdp)
        await session.refresh(other_brdp)

    try:
        response = await client.delete(f"/api/projects/{project.id}", headers=_headers(admin))
        assert response.status_code == 204

        async with async_session_factory() as session:
            assert await session.get(Project, project.id) is None
            assert await session.get(BRDP, brdp.id) is None
            assert await session.get(Note, brdp.id) is None
            assert (
                await session.execute(select(RuleApproval).where(RuleApproval.brdp_id == brdp.id))
            ).scalar_one_or_none() is None
            assert (
                await session.execute(
                    select(SuggestionFeedback).where(SuggestionFeedback.brdp_id == brdp.id)
                )
            ).scalar_one_or_none() is None

            # The other project and its own BRDP/note are untouched.
            assert await session.get(Project, other_project.id) is not None
            assert await session.get(BRDP, other_brdp.id) is not None
            assert await session.get(Note, other_brdp.id) is not None
    finally:
        async with async_session_factory() as session:
            db_other = await session.get(Project, other_project.id)
            if db_other is not None:
                await session.delete(db_other)
            await session.commit()
        await _cleanup_user(admin)


async def test_delete_unknown_project_is_404(client):
    admin = await _make_user(global_role="admin")
    try:
        response = await client.delete(f"/api/projects/{uuid.uuid4()}", headers=_headers(admin))
        assert response.status_code == 404
    finally:
        await _cleanup_user(admin)
