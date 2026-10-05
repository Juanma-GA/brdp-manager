import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.config import get_settings


class RuleExtractJobAccepted(BaseModel):
    job_id: uuid.UUID


class RuleExtractJobOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    filename: str
    file_format: str
    # "rules" (a BREX / Schematron) or "text" (AI Extract 2/2: free text).
    source_kind: str = "rules"
    word_count: int | None = None
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
    drafting_stopped: bool = False


class RuleExtractCandidatesOut(BaseModel):
    job_id: uuid.UUID
    candidates: list[dict]
    # The rows the job read and the ones of its manifest the server does not
    # have (should never happen; named rather than counted -- HR7).
    total_items: int = 0
    missing: list[dict] = Field(default_factory=list)


class RuleExtractCandidateKeysOut(BaseModel):
    """Every candidate's key, identifiers and classification, without its
    texts and rule: what the page compares with its own rows when it shows
    fewer than the job read."""

    job_id: uuid.UUID
    total_items: int
    keys: list[dict]
    missing: list[dict] = Field(default_factory=list)


class RuleExtractDraftingRequest(BaseModel):
    stopped: bool


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


class RuleExtractLimitsOut(BaseModel):
    max_words: int
    max_chars: int


class RuleExtractTextRequest(BaseModel):
    """A free text (pasted, or read from a file in the browser). filename is
    the file's name; empty for a pasted text."""

    text: str
    filename: str = Field(default="", max_length=255)


class RuleExtractSourceTextOut(BaseModel):
    job_id: uuid.UUID
    text: str
    word_count: int


_TEXT_MAX_CHARS = get_settings().extract_text_max_chars


class RuleExtractDecision(BaseModel):
    """One decision the AI found: the literal quote and a short title.

    Bounded here only by the text itself (a quote must be in it); the real
    limits are checked per decision, never by refusing the whole list: a
    quote over Settings.extract_quote_max_chars refuses that candidate with a
    warning, a title over the BRDP title limit is kept whole and blocks that
    row's import until it is shortened (AACF 1, Part 4)."""

    quote: str = Field(max_length=_TEXT_MAX_CHARS)
    title: str = Field(default="", max_length=_TEXT_MAX_CHARS)


class RuleExtractDecisions(BaseModel):
    decisions: list[RuleExtractDecision] = Field(default_factory=list, max_length=1000)
