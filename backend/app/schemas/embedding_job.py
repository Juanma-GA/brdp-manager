import uuid
from datetime import datetime

from pydantic import BaseModel


class EmbeddingPendingOut(BaseModel):
    """GET .../embeddings/pending -- backs the Suggest area's banner/button
    gate (docs request): shown, and Suggest disabled, whenever either count
    is non-zero.
    """

    project_pending: int
    catalog_pending: int
    # Suggest Rule adjustments round, Part 6: the id of the project's only
    # pending BRDP when exactly one is pending, else null -- lets Suggest
    # stay enabled when that one is the selected BRDP (it gets embedded on
    # the fly first, via POST .../embeddings/brdps/{id}).
    only_pending_brdp_id: uuid.UUID | None = None


class SingleBrdpEmbeddingOut(BaseModel):
    embedded: bool


class EmbeddingJobAccepted(BaseModel):
    job_id: uuid.UUID


class EmbeddingJobResultSummary(BaseModel):
    brdps_embedded: int
    catalog_embedded: int


class EmbeddingJobStatusOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    status: str  # "running" | "completed" | "failed"
    total_items: int
    processed_items: int
    error: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    result: EmbeddingJobResultSummary | None = None
