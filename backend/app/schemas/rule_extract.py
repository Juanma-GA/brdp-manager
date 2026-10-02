import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class RuleExtractJobAccepted(BaseModel):
    job_id: uuid.UUID


class RuleExtractJobOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    filename: str
    file_format: str
    status: str
    phase: str
    total_items: int
    processed_items: int
    error: str | None = None
    warnings: list | None = None
    apply_result: dict | None = None
    started_at: datetime
    finished_at: datetime | None = None
    applied_at: datetime | None = None


class RuleExtractCandidatesOut(BaseModel):
    job_id: uuid.UUID
    candidates: list[dict]


class RuleExtractCandidateEdit(BaseModel):
    key: str
    title: str | None = None
    definition: str | None = None
    proposal: str | None = None
    draft_status: str | None = None
    selected: bool | None = None
    classification: str | None = None


class RuleExtractCandidateEdits(BaseModel):
    items: list[RuleExtractCandidateEdit] = Field(default_factory=list, max_length=5000)


class RuleExtractApplyRequest(BaseModel):
    keys: list[str] = Field(default_factory=list, max_length=20000)
    # "pending": Proposal Pending + rule Draft (review them here).
    # "in_force": the file is a BREX/Schematron already in use -- Proposal
    # Validated + rule Verified, for the candidates whose rule passes the
    # format check (the others stay Pending/Draft).
    import_as: Literal["pending", "in_force"] = "pending"
