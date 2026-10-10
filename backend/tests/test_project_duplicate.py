"""Duplicar un proyecto: POST /api/projects/{id}/duplicate.

The copy is a snapshot: same standard and configuration, the active BRDPs
with their embeddings, their rules with status and last test, one
"copied_from" History entry per BRDP and one audit row -- nothing from the
Papelera, the jobs or the source's History. Afterwards the two projects
are independent.

One test per case of the encargo's table, plus independence, /similar on
the copy without re-embedding, and a copy of the 2819-BRDP scale project
(scripts/seed_sopte_scale_verification.py) with its time.

Real Postgres; only the embeddings transport of /similar is mocked.
"""
import importlib.util
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import delete, func, select

from app.api.deps import get_httpx_transport
from app.api.routes import projects as projects_routes
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import (
    BRDP,
    AuditLog,
    BRDPHistory,
    EmbeddingJob,
    ImportJob,
    Project,
    RuleApproval,
    RuleExtractJob,
    User,
    UserProjectRole,
)
from app.models.brdp import EMBEDDING_DIM
from app.services.embeddings import brdp_embedding_text, compute_text_hash
from app.services.rule_test_category import rule_xml_hash

PASSWORD = "Duplicate-pw-123"
_VECTOR = [1.0] + [0.0] * (EMBEDDING_DIM - 1)
_RULE = '<structureObjectRule id="R-1"><objectPath allowedObjectFlag="0">//emphasis</objectPath></structureObjectRule>'
_DITA_RULE = '<sch:pattern id="p-1"><sch:rule context="note"><sch:assert test="@type">x</sch:assert></sch:rule></sch:pattern>'


def _headers(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _user(prefix, global_role="user"):
    return User(
        email=f"{prefix}-{uuid.uuid4()}@example.com",
        password_hash=hash_password(PASSWORD),
        display_name=prefix,
        global_role=global_role,
    )


@pytest.fixture
def embed_calls():
    """Counts the embeddings calls of /similar (the query only, if nothing
    in the copy needs re-embedding)."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["input"]
        calls.append(len(texts))
        return httpx.Response(200, json={"data": [{"embedding": _VECTOR, "index": i} for i in range(len(texts))]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    yield calls
    app.dependency_overrides.pop(get_httpx_transport, None)


async def _cleanup(project_ids, user_ids):
    async with async_session_factory() as session:
        await session.execute(delete(AuditLog).where(AuditLog.project_id.in_(project_ids)))
        brdp_ids = select(BRDP.id).where(BRDP.project_id.in_(project_ids))
        await session.execute(delete(BRDPHistory).where(BRDPHistory.brdp_id.in_(brdp_ids)))
        await session.execute(delete(Project).where(Project.id.in_(project_ids)))
        await session.execute(delete(User).where(User.id.in_(user_ids)))
        await session.commit()


@pytest.fixture
async def world():
    """A source project (synthetic standard, a config with a nested value):
    BRDP A Validated with an embedding up to date, a refusal reason and two
    rules (a Verified BREX rule with a passed, up-to-date test and a saved
    passed test; a Draft rule under another format); BRDP B Pending without
    an embedding; BRDP C in the Papelera with a rule; and one History row of
    the source. An admin, an editor and a viewer of the source."""
    standard = f"TEST-DUP-{uuid.uuid4()}"
    created_projects = []
    async with async_session_factory() as session:
        source = Project(
            name=f"Dup source {uuid.uuid4()}",
            standard=standard,
            project_config={"modelIdentCode": "DUPX", "nested": {"a": "1"}, "schemaLocation": "flat"},
        )
        admin = _user("dup-admin", "admin")
        editor = _user("dup-editor")
        viewer = _user("dup-viewer")
        session.add_all([source, admin, editor, viewer])
        await session.flush()
        session.add_all(
            [
                UserProjectRole(user_id=editor.id, project_id=source.id, role="editor"),
                UserProjectRole(user_id=viewer.id, project_id=source.id, role="viewer"),
            ]
        )
        a = BRDP(
            project_id=source.id,
            identifier="BRDP-DUP-00001",
            title="Emphasis",
            definition="Decide whether emphasis is used.",
            proposal="Emphasis shall not be used.",
            validation="Validated",
            comments="",
        )
        a.embedding = _VECTOR
        a.embedding_text_hash = compute_text_hash(brdp_embedding_text(a))
        b = BRDP(
            project_id=source.id,
            identifier="BRDP-DUP-00002",
            title="Tables",
            definition="Decide how tables are used.",
            proposal="",
            validation="Refused",
            comments="Too vague",
        )
        c = BRDP(
            project_id=source.id,
            identifier="BRDP-DUP-00003",
            title="In the Papelera",
            validation="Validated",
            deleted_at=datetime.now(timezone.utc),
        )
        session.add_all([a, b, c])
        await session.flush()
        tested_at = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
        session.add_all(
            [
                RuleApproval(
                    brdp_id=a.id,
                    format="BREX-4.2",
                    rule_xml=_RULE,
                    source="manual",
                    status="approved",
                    approved_at=tested_at,
                    last_test_result="passed",
                    last_test_reason=None,
                    last_test_at=tested_at,
                    last_test_by=admin.id,
                    last_test_rule_hash=rule_xml_hash(_RULE),
                    last_passed_test={"at": tested_at.isoformat(), "rule_hash": rule_xml_hash(_RULE), "examples": []},
                    correction_dismissed_hash="ab" * 32,
                ),
                RuleApproval(brdp_id=a.id, format="SCH-DITA", rule_xml=_DITA_RULE, source="llm", status="pending_review"),
                RuleApproval(brdp_id=c.id, format="BREX-4.2", rule_xml=_RULE, source="manual", status="approved"),
                BRDPHistory(brdp_id=a.id, user_id=admin.id, user_email=admin.email, field_name="title", old_value="x", new_value="Emphasis"),
            ]
        )
        await session.commit()
        ids = {
            "standard": standard,
            "source": source.id,
            "source_name": source.name,
            "a": a.id,
            "b": b.id,
            "c": c.id,
            "admin": admin,
            "editor": editor,
            "viewer": viewer,
            "created": created_projects,
        }
    yield ids
    await _cleanup([source.id, *created_projects], [admin.id, editor.id, viewer.id])


async def _duplicate(client, world, name, user=None):
    response = await client.post(
        f"/api/projects/{world['source']}/duplicate", json={"name": name}, headers=_headers(user or world["admin"])
    )
    if response.status_code == 201:
        world["created"].append(uuid.UUID(response.json()["id"]))
    return response


async def _copy_brdps(project_id):
    async with async_session_factory() as session:
        rows = (await session.execute(select(BRDP).where(BRDP.project_id == project_id))).scalars().all()
        return {b.identifier: b for b in rows}


async def test_copy_has_the_active_brdps_their_rules_tests_and_embeddings(client, world):
    response = await _duplicate(client, world, "  Copy of the source  ")
    assert response.status_code == 201
    out = response.json()
    assert out["name"] == "Copy of the source"
    assert out["standard"] == world["standard"]
    assert out["project_config"] == {"modelIdentCode": "DUPX", "nested": {"a": "1"}, "schemaLocation": "flat"}
    assert out["effective_role"] == "editor"
    assert out["proposal_status_counts"] == {"validated": 1, "pending": 0, "refused": 1}
    copy_id = uuid.UUID(out["id"])

    source_brdps = await _copy_brdps(world["source"])
    copied = await _copy_brdps(copy_id)
    assert set(copied) == {"BRDP-DUP-00001", "BRDP-DUP-00002"}  # never the Papelera
    for identifier, new in copied.items():
        old = source_brdps[identifier]
        assert new.id != old.id
        for field in ("title", "definition", "proposal", "validation", "comments", "embedding_text_hash"):
            assert getattr(new, field) == getattr(old, field), field
        assert new.deleted_at is None
    assert list(copied["BRDP-DUP-00001"].embedding) == _VECTOR
    assert copied["BRDP-DUP-00002"].embedding is None

    async with async_session_factory() as session:
        rules = (
            await session.execute(select(RuleApproval).where(RuleApproval.brdp_id == copied["BRDP-DUP-00001"].id))
        ).scalars().all()
        source_rules = (
            await session.execute(select(RuleApproval).where(RuleApproval.brdp_id == world["a"]))
        ).scalars().all()
    by_format = {r.format: r for r in rules}
    assert set(by_format) == {"BREX-4.2", "SCH-DITA"}
    for old in source_rules:
        new = by_format[old.format]
        for column in RuleApproval.__table__.columns.keys():
            if column != "brdp_id":
                assert getattr(new, column) == getattr(old, column), column

    # The indicator: "Tested ✓", up to date, in the copy.
    approval = await client.get(
        f"/api/projects/{copy_id}/brdps/{copied['BRDP-DUP-00001'].id}/approvals/BREX-4.2",
        headers=_headers(world["admin"]),
    )
    assert approval.status_code == 200
    assert approval.json()["test_category"] == "passed"
    assert approval.json()["last_test_up_to_date"] is True
    assert approval.json()["status"] == "approved"

    # Nothing pending to embed in the copy (the source had nothing pending).
    pending = await client.get(f"/api/projects/{copy_id}/embeddings/pending", headers=_headers(world["admin"]))
    assert pending.json()["project_pending"] == 0


async def test_each_copied_brdp_has_one_copied_from_entry_and_no_source_history(client, world):
    copy_id = uuid.UUID((await _duplicate(client, world, f"History copy {uuid.uuid4()}")).json()["id"])
    copied = await _copy_brdps(copy_id)
    for brdp in copied.values():
        history = (
            await client.get(f"/api/projects/{copy_id}/brdps/{brdp.id}/history", headers=_headers(world["admin"]))
        ).json()
        assert [h["field_name"] for h in history] == ["copied_from"]
        value = json.loads(history[0]["new_value"])
        assert value == {
            "project_id": str(world["source"]),
            "project_name": world["source_name"],
            "standard": world["standard"],
        }
        assert history[0]["user_email"] == world["admin"].email


async def test_audit_row_names_the_copy_and_the_source(client, world):
    copy_id = uuid.UUID((await _duplicate(client, world, f"Audit copy {uuid.uuid4()}")).json()["id"])
    async with async_session_factory() as session:
        rows = (await session.execute(select(AuditLog).where(AuditLog.target_id == copy_id))).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "project.duplicated"
    assert row.target_type == "project" and row.project_id == copy_id
    assert row.actor_email == world["admin"].email
    assert row.detail["source_project_id"] == str(world["source"])
    assert row.detail["source_project_name"] == world["source_name"]
    assert row.detail["brdp_count"] == 2 and row.detail["rule_count"] == 2
    listed = await client.get("/api/admin/audit-log?action=project.duplicated", headers=_headers(world["admin"]))
    assert str(copy_id) in {r["target_id"] for r in listed.json()["rows"]}


@pytest.mark.parametrize("variant", ["upper", "accents"])
async def test_name_of_another_active_project_is_refused(client, world, variant):
    base = f"Proyecto Ñandú {uuid.uuid4().hex[:6]}"
    async with async_session_factory() as session:
        other = Project(name=base, standard=world["standard"])
        session.add(other)
        await session.commit()
    world["created"].append(other.id)
    wanted = base.upper() if variant == "upper" else base.replace("Ñandú", "nandu")
    response = await _duplicate(client, world, wanted)
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "project_name_taken" and detail["name"] == wanted and detail["action"] == "duplicate"
    async with async_session_factory() as session:
        count = (await session.execute(select(func.count()).select_from(Project).where(Project.name == wanted))).scalar_one()
    assert count == 0


async def test_name_of_the_source_itself_is_refused(client, world):
    response = await _duplicate(client, world, world["source_name"].lower())
    assert response.status_code == 409


async def test_name_of_a_project_in_the_papelera_is_allowed(client, world):
    name = f"Trashed name {uuid.uuid4()}"
    async with async_session_factory() as session:
        trashed = Project(name=name, standard=world["standard"], deleted_at=datetime.now(timezone.utc))
        session.add(trashed)
        await session.commit()
    world["created"].append(trashed.id)
    assert (await _duplicate(client, world, name)).status_code == 201


@pytest.mark.parametrize("name", ["", "   ", "x" * 201])
async def test_name_must_be_given_and_within_the_limit(client, world, name):
    response = await _duplicate(client, world, name)
    assert response.status_code == 422


async def test_name_at_the_limit_is_accepted(client, world):
    assert (await _duplicate(client, world, "y" * 199 + uuid.uuid4().hex[:1])).status_code == 201


async def test_empty_project_gives_an_empty_copy_with_its_config(client, world):
    async with async_session_factory() as session:
        empty = Project(name=f"Empty {uuid.uuid4()}", standard="DITA 1.3 Xpath3.0", project_config={"projectName": "Navantia"})
        session.add(empty)
        await session.commit()
    world["created"].append(empty.id)
    response = await client.post(
        f"/api/projects/{empty.id}/duplicate", json={"name": f"Empty copy {uuid.uuid4()}"}, headers=_headers(world["admin"])
    )
    assert response.status_code == 201
    world["created"].append(uuid.UUID(response.json()["id"]))
    assert response.json()["standard"] == "DITA 1.3 Xpath3.0"
    assert response.json()["project_config"] == {"projectName": "Navantia"}
    assert response.json()["proposal_status_counts"] == {"validated": 0, "pending": 0, "refused": 0}
    assert await _copy_brdps(uuid.UUID(response.json()["id"])) == {}


@pytest.mark.parametrize("job_model,kind", [(ImportJob, "import"), (EmbeddingJob, "embeddings"), (RuleExtractJob, "extraction")])
async def test_a_running_job_in_the_source_refuses_the_copy(client, world, job_model, kind):
    async with async_session_factory() as session:
        counts = {"total_rows": 3} if job_model is ImportJob else {"total_items": 3}
        job = job_model(project_id=world["source"], status="running", **counts)
        session.add(job)
        await session.commit()
    name = f"Job copy {uuid.uuid4()}"
    response = await _duplicate(client, world, name)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "project_has_running_job"
    assert response.json()["detail"]["jobs"] == [kind]
    assert response.json()["detail"]["action"] == "duplicate"
    async with async_session_factory() as session:
        assert (await session.execute(select(Project).where(Project.name == name))).scalar_one_or_none() is None
        (await session.get(job_model, job.id)).status = "completed"
        await session.commit()


async def test_finished_jobs_are_not_copied(client, world):
    async with async_session_factory() as session:
        session.add(EmbeddingJob(project_id=world["source"], status="completed", total_items=1, processed_items=1))
        await session.commit()
    copy_id = uuid.UUID((await _duplicate(client, world, f"Jobs copy {uuid.uuid4()}")).json()["id"])
    async with async_session_factory() as session:
        for model in (ImportJob, EmbeddingJob, RuleExtractJob):
            count = (await session.execute(select(func.count()).select_from(model).where(model.project_id == copy_id))).scalar_one()
            assert count == 0
        roles = (await session.execute(select(func.count()).select_from(UserProjectRole).where(UserProjectRole.project_id == copy_id))).scalar_one()
        assert roles == 0


@pytest.mark.parametrize("who", ["editor", "viewer"])
async def test_only_an_admin_can_duplicate(client, world, who):
    name = f"Not allowed {uuid.uuid4()}"
    response = await _duplicate(client, world, name, user=world[who])
    assert response.status_code == 403
    async with async_session_factory() as session:
        assert (await session.execute(select(Project).where(Project.name == name))).scalar_one_or_none() is None


async def test_source_in_the_papelera_or_missing_is_not_found(client, world):
    missing = await client.post(f"/api/projects/{uuid.uuid4()}/duplicate", json={"name": "x"}, headers=_headers(world["admin"]))
    assert missing.status_code == 404
    async with async_session_factory() as session:
        (await session.get(Project, world["source"])).deleted_at = datetime.now(timezone.utc)
        await session.commit()
    assert (await _duplicate(client, world, f"From trash {uuid.uuid4()}")).status_code == 404


async def test_a_failure_midway_leaves_nothing(client, world, monkeypatch):
    def broken_record(db, actor, action, **kwargs):
        # A row the table's CHECK constraint refuses: the commit fails after
        # every copy statement has run.
        db.add(AuditLog(actor_id=actor.id, actor_email=actor.email, action="not.an.action", target_type="project", target_label="x"))

    monkeypatch.setattr(projects_routes, "record", broken_record)
    name = f"Half copy {uuid.uuid4()}"
    response = await _duplicate(client, world, name)
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "internal_error"
    async with async_session_factory() as session:
        assert (await session.execute(select(Project).where(Project.name == name))).scalar_one_or_none() is None
        orphan = (
            await session.execute(
                select(func.count()).select_from(BRDPHistory).where(BRDPHistory.field_name == "copied_from", BRDPHistory.new_value.contains(str(world["source"])))
            )
        ).scalar_one()
        assert orphan == 0


async def test_copy_and_source_are_independent(client, world):
    copy_id = uuid.UUID((await _duplicate(client, world, f"Independent {uuid.uuid4()}")).json()["id"])
    copied = await _copy_brdps(copy_id)
    admin = _headers(world["admin"])
    new_a = copied["BRDP-DUP-00001"].id

    # Edit the copy: title and rule.
    assert (await client.put(f"/api/projects/{copy_id}/brdps/{new_a}", json={"title": "Changed in copy"}, headers=admin)).status_code == 200
    new_rule = _RULE.replace("//emphasis", "//para")
    put = await client.put(
        f"/api/projects/{copy_id}/brdps/{new_a}/approvals/BREX-4.2",
        json={"rule_xml": new_rule, "status": "pending_review", "source": "manual"},
        headers=admin,
    )
    assert put.status_code == 200
    async with async_session_factory() as session:
        source_a = await session.get(BRDP, world["a"])
        source_rule = await session.get(RuleApproval, (world["a"], "BREX-4.2"))
        assert source_a.title == "Emphasis"
        assert source_rule.rule_xml == _RULE and source_rule.status == "approved"
        assert source_rule.last_test_rule_hash == rule_xml_hash(_RULE)

    # Edit the source: the copy does not move.
    assert (await client.put(f"/api/projects/{world['source']}/brdps/{world['b']}", json={"definition": "Changed in source"}, headers=admin)).status_code == 200
    async with async_session_factory() as session:
        assert (await session.get(BRDP, copied["BRDP-DUP-00002"].id)).definition == "Decide how tables are used."
    # Deleting the source does not touch the copy.
    assert (await client.delete(f"/api/projects/{world['source']}?permanent=true", headers=admin)).status_code == 204
    assert set(await _copy_brdps(copy_id)) == {"BRDP-DUP-00001", "BRDP-DUP-00002"}
    async with async_session_factory() as session:
        assert (await session.get(RuleApproval, (new_a, "SCH-DITA"))) is not None


async def test_copy_of_a_copy(client, world):
    first = uuid.UUID((await _duplicate(client, world, f"First {uuid.uuid4()}")).json()["id"])
    first_name = (await client.get(f"/api/projects/{first}/config", headers=_headers(world["admin"]))).json()["name"]
    response = await client.post(
        f"/api/projects/{first}/duplicate", json={"name": f"Second {uuid.uuid4()}"}, headers=_headers(world["admin"])
    )
    assert response.status_code == 201
    second = uuid.UUID(response.json()["id"])
    world["created"].append(second)
    copied = await _copy_brdps(second)
    assert set(copied) == {"BRDP-DUP-00001", "BRDP-DUP-00002"}
    history = (
        await client.get(f"/api/projects/{second}/brdps/{copied['BRDP-DUP-00001'].id}/history", headers=_headers(world["admin"]))
    ).json()
    assert [h["field_name"] for h in history] == ["copied_from"]
    assert json.loads(history[0]["new_value"])["project_name"] == first_name
    async with async_session_factory() as session:
        rule = await session.get(RuleApproval, (copied["BRDP-DUP-00001"].id, "BREX-4.2"))
    assert rule.last_test_result == "passed" and rule.last_test_rule_hash == rule_xml_hash(_RULE)


async def test_similar_on_the_copy_uses_the_copied_embeddings(client, world, embed_calls):
    copy_id = uuid.UUID((await _duplicate(client, world, f"Similar copy {uuid.uuid4()}")).json()["id"])
    copied = await _copy_brdps(copy_id)
    response = await client.get(
        f"/api/projects/{copy_id}/brdps/{copied['BRDP-DUP-00002'].id}/similar?kind=proposal",
        headers=_headers(world["admin"]),
    )
    assert response.status_code == 200
    this_project = response.json()["this_project"]
    assert [c["id"] for c in this_project] == [str(copied["BRDP-DUP-00001"].id)]
    # One embeddings call: the query text. The copy's own BRDPs were not re-embedded.
    assert embed_calls == [1]
    pending = await client.get(f"/api/projects/{copy_id}/embeddings/pending", headers=_headers(world["admin"]))
    assert pending.json()["project_pending"] == 0


def _scale_module():
    path = Path(__file__).resolve().parent.parent / "scripts" / "seed_sopte_scale_verification.py"
    spec = importlib.util.spec_from_file_location("seed_sopte_scale_verification", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_copy_of_a_2819_brdp_project(client, world):
    scale = _scale_module()
    async with async_session_factory() as session:
        big = Project(name=f"Scale {uuid.uuid4()}", standard="S1000D 4.2")
        session.add(big)
        await session.flush()
        brdp_rows, approval_rows = scale.scale_rows(big.id)
        await session.execute(BRDP.__table__.insert(), brdp_rows)
        await session.execute(RuleApproval.__table__.insert(), approval_rows)
        await session.commit()
    world["created"].append(big.id)

    started = time.monotonic()
    response = await client.post(
        f"/api/projects/{big.id}/duplicate", json={"name": f"Scale copy {uuid.uuid4()}"}, headers=_headers(world["admin"])
    )
    elapsed = time.monotonic() - started
    assert response.status_code == 201
    copy_id = uuid.UUID(response.json()["id"])
    world["created"].append(copy_id)
    print(f"\nDuplicated {scale.TOTAL} BRDPs and {len(approval_rows)} rules in {elapsed:.2f} s")
    assert response.json()["proposal_status_counts"] == {
        "validated": scale.N_VALIDATED,
        "pending": scale.N_PENDING,
        "refused": scale.N_REFUSED,
    }
    assert response.json()["rule_status_counts"] == {
        "verified": scale.N_VERIFIED,
        "draft": scale.N_DRAFT,
        "to_do": scale.N_TODO,
    }
    async with async_session_factory() as session:
        history = (
            await session.execute(
                select(func.count())
                .select_from(BRDPHistory)
                .join(BRDP, BRDP.id == BRDPHistory.brdp_id)
                .where(BRDP.project_id == copy_id, BRDPHistory.field_name == "copied_from")
            )
        ).scalar_one()
    assert history == scale.TOTAL
    assert elapsed < 30
