"""POST /api/suggestion-feedback -- docs/v2 §3 point 5. Not nested under
/api/projects/{project_id} (see app/api/routes/suggestion_feedback.py's
docstring for why), so authorization is tested explicitly here: it must
still respect the SAME project isolation rule as every other endpoint,
just derived from brdp_id instead of a path param.
"""
import uuid

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, Project, SuggestionFeedback, User, UserProjectRole


async def _make_project_with_brdp(standard: str = "S1000D 4.2") -> tuple[Project, BRDP]:
    async with async_session_factory() as session:
        project = Project(name=f"Feedback Test Project {uuid.uuid4()}", standard=standard)
        session.add(project)
        await session.flush()
        brdp = BRDP(project_id=project.id, identifier="BRDP-FB-001", definition="d", proposal="p")
        session.add(brdp)
        await session.commit()
        await session.refresh(project)
        await session.refresh(brdp)
        return project, brdp


async def _make_user(global_role: str = "user") -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"feedback-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Feedback Test User",
            global_role=global_role,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _assign_role(user_id: uuid.UUID, project_id: uuid.UUID, role: str) -> None:
    async with async_session_factory() as session:
        session.add(UserProjectRole(user_id=user_id, project_id=project_id, role=role))
        await session.commit()


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _cleanup(project: Project, users: list[User]) -> None:
    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        await session.commit()
    for user in users:
        async with async_session_factory() as session:
            db_user = await session.get(User, user.id)
            if db_user is not None:
                await session.delete(db_user)
            await session.commit()


async def test_requires_authentication(client):
    response = await client.post(
        "/api/suggestion-feedback",
        json={"brdp_id": str(uuid.uuid4()), "kind": "definition", "suggested_text": "x", "outcome": "discarded"},
    )
    assert response.status_code == 401


async def test_viewer_can_log_feedback_and_it_is_really_persisted(client):
    """The real point of this test: query Postgres directly afterward,
    not just trust the 201 -- docs/v2 §3 point 5's whole reason to exist
    is having a real row to review later.
    """
    project, brdp = await _make_project_with_brdp()
    viewer = await _make_user()
    await _assign_role(viewer.id, project.id, "viewer")
    try:
        response = await client.post(
            "/api/suggestion-feedback",
            json={
                "brdp_id": str(brdp.id),
                "kind": "definition",
                "suggested_text": "a suggested definition",
                "source_brdp_ids": [str(uuid.uuid4()), str(uuid.uuid4())],
                "outcome": "discarded",
            },
            headers=_headers(viewer),
        )
        assert response.status_code == 201
        body = response.json()
        feedback_id = uuid.UUID(body["id"])

        async with async_session_factory() as session:
            row = (
                await session.execute(select(SuggestionFeedback).where(SuggestionFeedback.id == feedback_id))
            ).scalar_one()
            assert row.brdp_id == brdp.id
            assert row.kind == "definition"
            assert row.outcome == "discarded"
            assert row.suggested_text == "a suggested definition"
            assert len(row.source_brdp_ids) == 2
    finally:
        await _cleanup(project, [viewer])


async def test_user_outside_the_project_is_rejected(client):
    """Cross-project isolation, derived from brdp_id -- the same class of
    bug test_authorization.py covers for path-scoped endpoints, here for
    the one endpoint that isn't path-scoped.
    """
    project, brdp = await _make_project_with_brdp()
    outsider = await _make_user()
    try:
        response = await client.post(
            "/api/suggestion-feedback",
            json={"brdp_id": str(brdp.id), "kind": "definition", "suggested_text": "x", "outcome": "discarded"},
            headers=_headers(outsider),
        )
        assert response.status_code == 403
    finally:
        await _cleanup(project, [outsider])


async def test_unknown_brdp_id_is_404(client):
    someone = await _make_user(global_role="admin")
    response = await client.post(
        "/api/suggestion-feedback",
        json={"brdp_id": str(uuid.uuid4()), "kind": "definition", "suggested_text": "x", "outcome": "discarded"},
        headers=_headers(someone),
    )
    assert response.status_code == 404
    async with async_session_factory() as session:
        db_user = await session.get(User, someone.id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def test_invalid_kind_or_outcome_is_rejected(client):
    project, brdp = await _make_project_with_brdp()
    viewer = await _make_user()
    await _assign_role(viewer.id, project.id, "viewer")
    try:
        response = await client.post(
            "/api/suggestion-feedback",
            json={"brdp_id": str(brdp.id), "kind": "not-a-real-kind", "suggested_text": "x", "outcome": "discarded"},
            headers=_headers(viewer),
        )
        assert response.status_code == 422
    finally:
        await _cleanup(project, [viewer])
