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
