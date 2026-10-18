"""Shared pieces of the three background-job services (import_jobs.py,
embedding_jobs.py, rule_extract_jobs.py) and their routes.

STALE_JOB_MINUTES: a `running` job older than this is taken as dead (a hard
process crash with no chance to run its own cleanup) and marked `failed` on
the next read that notices it, so neither the 409 check nor the UI goes on
trusting a `running` status that can no longer be true.
"""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

STALE_JOB_MINUTES = 60
_STALE_JOB_THRESHOLD = timedelta(minutes=STALE_JOB_MINUTES)

# Texts per embeddings request. Starting value 32 -- research into
# Mistral's real per-request item limit was inconclusive from this
# sandbox (docs.mistral.ai unreachable; secondary sources disagreed,
# citing figures from 16 to 128), but Mistral's own official cookbook
# example (github.com/mistralai/cookbook, mistral/embeddings/
# embeddings.ipynb) successfully batches 1,153 real texts at a chunk size
# of 50 -- real, current, first-party usage strictly above 32, which is
# the closest thing to primary-source confirmation reachable here that
# 32 is safely within the real limit. If Mistral's real limit ever turns
# out to be lower than this, that surfaces as a real batch failure
# through the retry-once-then-fail path in embedding_jobs.py, never
# silently.
EMBED_BATCH_SIZE = 32


async def reap_if_stale(job, db: AsyncSession, what: str):
    """Marks a stale `running` job `failed` ("<what> likely interrupted --
    no progress for over N minutes") in the same read that noticed it."""
    if job.status == "running" and datetime.now(timezone.utc) - job.started_at > _STALE_JOB_THRESHOLD:
        job.status = "failed"
        job.error = f"{what} likely interrupted — no progress for over {STALE_JOB_MINUTES} minutes"
        job.finished_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(job)
    return job


async def get_job_in_project(model, project_id: uuid.UUID, job_id: uuid.UUID, db: AsyncSession, not_found: str):
    """The job, or 404 `not_found` if it does not exist or belongs to
    another project."""
    job = await db.get(model, job_id)
    if job is None or job.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=not_found)
    return job
