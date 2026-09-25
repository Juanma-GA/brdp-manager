"""On-demand embeddings (docs request): pending detection (GET /pending)
and the background "Compute embeddings" job (POST /compute, GET
/status/active, GET /status/{job_id}) -- app/services/embedding_jobs.py
and app/api/routes/embedding_jobs.py. Real Postgres throughout; only the
Mistral embeddings call itself is mocked (via get_httpx_transport, same
pattern as test_similar.py), since this file's job is job-management/
pending-detection correctness, not embeddings correctness.
"""
import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import BRDP, BRDPCatalog, EmbeddingJob, Project, User, UserProjectRole
from app.services.embedding_jobs import EMBED_BATCH_SIZE, STALE_JOB_MINUTES, get_running_job, run_embedding_job
from app.services.embeddings import brdp_embedding_text, catalog_embedding_text, compute_text_hash


@pytest.fixture
async def editor_and_project():
    """The standard is a fresh synthetic string per test run, not a real
    one (docs request, "tests que dependen de los datos existentes"
    round): most tests below assert EXACT pending/embedded counts, which
    only hold if no other real catalog/BRDP data for that standard exists
    in the environment -- true by construction for a standard nothing
    else ever uses, false for any real standard string the moment this
    sandbox (or the user's own environment) has data for it.
    """
    async with async_session_factory() as session:
        project = Project(name=f"Embedding Test Project {uuid.uuid4()}", standard=f"TEST-EMBED-STANDARD-{uuid.uuid4()}")
        editor = User(
            email=f"embed-editor-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Embedding Test Editor",
            global_role="user",
        )
        viewer = User(
            email=f"embed-viewer-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Embedding Test Viewer",
            global_role="user",
        )
        session.add_all([project, editor, viewer])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        session.add(UserProjectRole(user_id=viewer.id, project_id=project.id, role="viewer"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(editor)
        await session.refresh(viewer)

    editor_headers = {"Authorization": f"Bearer {create_access_token(editor.id)}"}
    viewer_headers = {"Authorization": f"Bearer {create_access_token(viewer.id)}"}
    yield project, editor, editor_headers, viewer_headers

    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        for user_id in (editor.id, viewer.id):
            db_user = await session.get(User, user_id)
            if db_user is not None:
                await session.delete(db_user)
        await session.commit()


@pytest.fixture(autouse=True)
def _mock_embeddings_transport():
    """A real, deterministic Mistral response -- what actual vector is
    returned doesn't matter for this file (job-management/pending-
    detection correctness, not similarity correctness), only that
    compute_embeddings_batch() succeeds and embedding_text_hash gets set.
    Batch embeddings (docs request): must return exactly one data item
    PER text in the request's "input" list (a real batch call, unlike a
    single compute_embedding call, can carry more than one) -- returning
    only ever one item regardless of batch size, like this fixture did
    before the batching round, would make every test that embeds more
    than one pending row at once fail with a real index-mismatch error.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        count = len(sent["input"])
        return httpx.Response(200, json={"data": [{"embedding": [0.1] * 1024, "index": i} for i in range(count)]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


async def _make_validated_brdp(project_id: uuid.UUID, identifier: str, **overrides) -> BRDP:
    async with async_session_factory() as session:
        brdp = BRDP(
            project_id=project_id,
            identifier=identifier,
            title=overrides.get("title", "Some title"),
            definition=overrides.get("definition", "Some definition"),
            proposal=overrides.get("proposal", "Some proposal"),
            validation="Validated",
            embedding=overrides.get("embedding"),
            embedding_text_hash=overrides.get("embedding_text_hash"),
        )
        session.add(brdp)
        await session.commit()
        await session.refresh(brdp)
        return brdp


async def _make_catalog_entry(standard: str, identifier: str, **overrides) -> BRDPCatalog:
    async with async_session_factory() as session:
        entry = BRDPCatalog(
            standard=standard,
            identifier=identifier,
            title=overrides.get("title", "Catalog title"),
            definition=overrides.get("definition", "Catalog definition"),
            embedding=overrides.get("embedding"),
            embedding_text_hash=overrides.get("embedding_text_hash"),
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)
        return entry


async def _cleanup_catalog(entry_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        db_entry = await session.get(BRDPCatalog, entry_id)
        if db_entry is not None:
            await session.delete(db_entry)
        await session.commit()


async def _compute_and_wait(client, project_id, headers):
    """Same bounded-poll pattern as test_brdp_import.py's _apply_and_wait
    -- POST /compute returns 202 immediately, the actual work runs via
    BackgroundTasks (in practice already finished by the time this returns
    under the test client's ASGITransport, but this polls rather than
    assumes that). Returns the final EmbeddingJobStatusOut body.
    """
    resp = await client.post(f"/api/projects/{project_id}/embeddings/compute", headers=headers)
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    for _ in range(20):
        status_resp = await client.get(f"/api/projects/{project_id}/embeddings/status/{job_id}", headers=headers)
        body = status_resp.json()
        if body["status"] != "running":
            return body
        await asyncio.sleep(0.25)
    raise AssertionError(f"Embedding job {job_id} never left 'running' status")


async def test_never_embedded_validated_brdp_is_pending(client, editor_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    await _make_validated_brdp(project.id, "BRDP-EMB-NEW")

    resp = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=editor_headers)
    assert resp.status_code == 200
    assert resp.json() == {"project_pending": 1, "catalog_pending": 0}


async def test_embedded_brdp_with_matching_hash_is_not_pending(client, editor_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    text = "T\n\nD\n\nP"  # same composition as brdp_embedding_text(title, definition, proposal)
    await _make_validated_brdp(
        project.id, "BRDP-EMB-CURRENT", title="T", definition="D", proposal="P",
        embedding=[0.1] * 1024, embedding_text_hash=compute_text_hash(text),
    )

    resp = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=editor_headers)
    assert resp.status_code == 200
    assert resp.json() == {"project_pending": 0, "catalog_pending": 0}


async def test_editing_title_after_embedding_marks_brdp_pending_again(client, editor_and_project):
    """The exact edge case named in the docs request: editing the title of
    an already-embedded BRDP must flip it back to pending -- proven here by
    a real PUT through the API (not a direct DB mutation), matching how a
    real edit actually happens.
    """
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    text = "Old title\n\nD\n\nP"  # same composition as brdp_embedding_text(title, definition, proposal)
    brdp = await _make_validated_brdp(
        project.id, "BRDP-EMB-EDITED", title="Old title", definition="D", proposal="P",
        embedding=[0.1] * 1024, embedding_text_hash=compute_text_hash(text),
    )

    before = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=editor_headers)
    assert before.json()["project_pending"] == 0

    upd = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp.id}", json={"title": "New title"}, headers=editor_headers
    )
    assert upd.status_code == 200

    after = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=editor_headers)
    assert after.json()["project_pending"] == 1


async def test_catalog_entry_pending_detection_same_hash_logic(client, editor_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    never_embedded = await _make_catalog_entry(project.standard, f"BRDP-CAT-{uuid.uuid4()}")
    text = "Catalog title\n\nCatalog definition"  # same composition as catalog_embedding_text(title, definition)
    already_current = await _make_catalog_entry(
        project.standard, f"BRDP-CAT-{uuid.uuid4()}", embedding=[0.1] * 1024, embedding_text_hash=compute_text_hash(text)
    )
    try:
        resp = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=editor_headers)
        assert resp.status_code == 200
        assert resp.json() == {"project_pending": 0, "catalog_pending": 1}
    finally:
        await _cleanup_catalog(never_embedded.id)
        await _cleanup_catalog(already_current.id)


async def test_pending_only_counts_other_projects_catalog_by_standard(client, editor_and_project):
    """The catalog is global, not project-scoped, but GET /pending must
    only ever look at the CURRENT project's own standard -- a pending
    catalog entry for a DIFFERENT standard must not be counted.
    """
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    other_standard_entry = await _make_catalog_entry("S1000D 3.0.1", f"BRDP-CAT-{uuid.uuid4()}")
    try:
        resp = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=editor_headers)
        assert resp.status_code == 200
        assert resp.json() == {"project_pending": 0, "catalog_pending": 0}
    finally:
        await _cleanup_catalog(other_standard_entry.id)


async def test_compute_embeds_pending_brdps_and_catalog_and_clears_pending(client, editor_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    brdp_a = await _make_validated_brdp(project.id, "BRDP-EMB-COMPUTE-A")
    brdp_b = await _make_validated_brdp(project.id, "BRDP-EMB-COMPUTE-B")
    catalog_entry = await _make_catalog_entry(project.standard, f"BRDP-CAT-{uuid.uuid4()}")
    try:
        pending_before = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=editor_headers)
        assert pending_before.json() == {"project_pending": 2, "catalog_pending": 1}

        body = await _compute_and_wait(client, project.id, editor_headers)
        assert body["status"] == "completed"
        assert body["total_items"] == 3
        assert body["processed_items"] == 3
        assert body["result"] == {"brdps_embedded": 2, "catalog_embedded": 1}

        pending_after = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=editor_headers)
        assert pending_after.json() == {"project_pending": 0, "catalog_pending": 0}

        async with async_session_factory() as session:
            for brdp_id in (brdp_a.id, brdp_b.id):
                db_brdp = await session.get(BRDP, brdp_id)
                assert db_brdp.embedding is not None
                assert db_brdp.embedding_text_hash == compute_text_hash(brdp_embedding_text(db_brdp))
            db_entry = await session.get(BRDPCatalog, catalog_entry.id)
            assert db_entry.embedding is not None
            assert db_entry.embedding_text_hash == compute_text_hash(catalog_embedding_text(db_entry))
    finally:
        await _cleanup_catalog(catalog_entry.id)


async def test_compute_skips_catalog_entirely_when_nothing_pending_there(client, editor_and_project):
    """Docs request: "El catálogo solo se calcula si tiene pendientes" --
    a catalog with nothing pending contributes 0 to total_items/result,
    never a spurious pass over it.
    """
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    await _make_validated_brdp(project.id, "BRDP-EMB-NOCATALOG")

    body = await _compute_and_wait(client, project.id, editor_headers)
    assert body["status"] == "completed"
    assert body["total_items"] == 1
    assert body["result"] == {"brdps_embedded": 1, "catalog_embedded": 0}


async def test_viewer_cannot_launch_compute(client, editor_and_project):
    project, _editor, _editor_headers, viewer_headers = editor_and_project
    resp = await client.post(f"/api/projects/{project.id}/embeddings/compute", headers=viewer_headers)
    assert resp.status_code == 403


async def test_viewer_can_read_pending_and_status(client, editor_and_project):
    project, _editor, _editor_headers, viewer_headers = editor_and_project
    pending = await client.get(f"/api/projects/{project.id}/embeddings/pending", headers=viewer_headers)
    assert pending.status_code == 200
    active = await client.get(f"/api/projects/{project.id}/embeddings/status/active", headers=viewer_headers)
    assert active.status_code == 200
    assert active.json() is None


async def test_second_compute_while_one_running_returns_409(client, editor_and_project):
    """Docs request's own edge case: two editors pressing the button at the
    same time must produce a single job. Simulated here by inserting a
    real `running` row directly (this sandbox can't race two real
    concurrent requests deterministically), same technique
    test_brdp_import.py already uses for its own concurrency test.
    """
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        job = EmbeddingJob(project_id=project.id, status="running", total_items=1)
        session.add(job)
        await session.commit()

    resp = await client.post(f"/api/projects/{project.id}/embeddings/compute", headers=editor_headers)
    assert resp.status_code == 409


async def test_stale_running_job_no_longer_blocks_and_is_marked_failed(client, editor_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    stale_started_at = datetime.now(timezone.utc) - timedelta(minutes=STALE_JOB_MINUTES + 1)
    async with async_session_factory() as session:
        job = EmbeddingJob(project_id=project.id, status="running", total_items=1, started_at=stale_started_at)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        stale_job_id = job.id

    resp = await client.post(f"/api/projects/{project.id}/embeddings/compute", headers=editor_headers)
    assert resp.status_code == 202  # not 409 -- the stale job no longer counts as blocking

    async with async_session_factory() as session:
        stale_job = await session.get(EmbeddingJob, stale_job_id)
        assert stale_job.status == "failed"
        assert str(STALE_JOB_MINUTES) in stale_job.error
        assert stale_job.finished_at is not None


async def test_run_embedding_job_marks_failed_on_cancellation(editor_and_project):
    """Same real root cause as import_jobs.py's own cancellation test:
    asyncio.CancelledError inherits BaseException (not Exception) since
    Python 3.8, so a plain `except Exception` never sees it -- confirms
    the dedicated `except asyncio.CancelledError` branch leaves the job
    row 'failed' with a clear message rather than abandoned 'running'
    forever, and that a fresh compute is no longer blocked afterward.
    """
    project, editor, _editor_headers, _viewer_headers = editor_and_project
    await _make_validated_brdp(project.id, "BRDP-EMB-CANCEL")

    async with async_session_factory() as session:
        job = EmbeddingJob(project_id=project.id, started_by=editor.id, status="running", total_items=1)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        job_id = job.id

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": [0.1] * 1024, "index": 0}]})

    task = asyncio.ensure_future(run_embedding_job(job_id, project.id, httpx.MockTransport(handler)))
    await asyncio.sleep(0)  # let the coroutine actually start (reach its first real await)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    async with async_session_factory() as session:
        db_job = await session.get(EmbeddingJob, job_id)
        assert db_job.status == "failed"
        assert "interrupted" in db_job.error.lower()

        assert await get_running_job(project.id, session) is None


async def test_status_active_returns_most_recent_job_regardless_of_status(client, editor_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        job = EmbeddingJob(
            project_id=project.id,
            status="completed",
            total_items=2,
            processed_items=2,
            result={"brdps_embedded": 2, "catalog_embedded": 0},
        )
        session.add(job)
        await session.commit()

    resp = await client.get(f"/api/projects/{project.id}/embeddings/status/active", headers=editor_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body is not None
    assert body["status"] == "completed"
    assert body["result"]["brdps_embedded"] == 2


async def test_status_job_id_rejects_a_job_from_another_project(client, editor_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        other_project = Project(name=f"Other Embedding Project {uuid.uuid4()}", standard="S1000D 4.2")
        session.add(other_project)
        await session.flush()
        job = EmbeddingJob(project_id=other_project.id, status="completed", total_items=1, processed_items=1)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        job_id = job.id
        other_project_id = other_project.id

    try:
        resp = await client.get(f"/api/projects/{project.id}/embeddings/status/{job_id}", headers=editor_headers)
        assert resp.status_code == 404
    finally:
        async with async_session_factory() as session:
            db_job = await session.get(EmbeddingJob, job_id)
            if db_job is not None:
                await session.delete(db_job)
            db_project = await session.get(Project, other_project_id)
            if db_project is not None:
                await session.delete(db_project)
            await session.commit()


async def test_unauthenticated_request_rejected(client, editor_and_project):
    project, _editor, _editor_headers, _viewer_headers = editor_and_project
    resp = await client.get(f"/api/projects/{project.id}/embeddings/pending")
    assert resp.status_code == 401


async def test_63_pending_brdps_makes_exactly_two_batch_requests_of_32_and_31(client, editor_and_project):
    """Docs request's own closing check: batching must cut the number of
    real HTTP requests, not just move the same one-per-item cost around --
    63 pending BRDPs at EMBED_BATCH_SIZE=32 must be exactly 2 requests
    (32 + 31), never 63.
    """
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    for i in range(63):
        await _make_validated_brdp(project.id, f"BRDP-EMB-BATCH-{i:02d}")

    call_sizes = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        call_sizes.append(len(sent["input"]))
        return httpx.Response(
            200, json={"data": [{"embedding": [0.1] * 1024, "index": i} for i in range(len(sent["input"]))]}
        )

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)

    body = await _compute_and_wait(client, project.id, editor_headers)
    assert body["status"] == "completed"
    assert body["result"]["brdps_embedded"] == 63
    assert call_sizes == [EMBED_BATCH_SIZE, 63 - EMBED_BATCH_SIZE]


async def test_1_pending_brdp_makes_exactly_one_batch_request(client, editor_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    await _make_validated_brdp(project.id, "BRDP-EMB-SINGLE")

    call_sizes = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        call_sizes.append(len(sent["input"]))
        return httpx.Response(
            200, json={"data": [{"embedding": [0.1] * 1024, "index": i} for i in range(len(sent["input"]))]}
        )

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)

    body = await _compute_and_wait(client, project.id, editor_headers)
    assert body["status"] == "completed"
    assert call_sizes == [1]


async def test_batch_assigns_the_vector_matching_each_brdps_own_text(client, editor_and_project):
    """The docs request's own closing verification method: a per-text
    deterministic mock lets us independently know what vector EACH BRDP
    should end up with, and confirm the one actually stored really is
    that one -- not another row's, and not scrambled by a response that
    comes back in a different order than it was sent (the mock here
    deliberately reverses it).
    """
    project, _editor, editor_headers, _viewer_headers = editor_and_project
    brdps = [
        await _make_validated_brdp(
            project.id, f"BRDP-EMB-ASSIGN-{i}", title=f"T{i}", definition=f"D{i}", proposal=f"P{i}"
        )
        for i in range(5)
    ]

    def vector_for_text(text: str) -> list[float]:
        # A distinct-but-valid-dimension vector per text (pgvector enforces
        # the real column dimension, so this can't just be a short list).
        value = (sum(ord(c) for c in text) % 997) / 997
        return [value] * 1024

    def handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        texts = sent["input"]
        data = [{"embedding": vector_for_text(t), "index": i} for i, t in enumerate(texts)]
        data.reverse()  # out-of-order response -- must still land by index, not response position
        return httpx.Response(200, json={"data": data})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)

    body = await _compute_and_wait(client, project.id, editor_headers)
    assert body["status"] == "completed"

    async with async_session_factory() as session:
        for brdp in brdps:
            db_brdp = await session.get(BRDP, brdp.id)
            expected = vector_for_text(brdp_embedding_text(db_brdp))
            assert list(db_brdp.embedding) == pytest.approx(expected), f"{brdp.identifier} got the wrong vector"
