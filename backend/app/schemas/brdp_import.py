import uuid
from datetime import datetime

from pydantic import BaseModel


class ImportRowIn(BaseModel):
    """One parsed Excel row -- field names mirror the columns Export to
    Excel already produces (ID/Title/Definition/Proposal/Proposal
    Status/Rule Status/Rule), since Import now accepts exactly that same
    7-column shape. row_number is the 1-based Excel row (the header is
    row 1, so the first data row is 2) -- carried through purely so the
    two-phase analyze/apply summary can reference "row 3" the same way a
    spreadsheet user would, even for a row whose identifier is blank or
    duplicated.
    """

    row_number: int
    identifier: str = ""
    title: str = ""
    definition: str = ""
    proposal: str = ""
    proposal_status: str = "Pending"
    rule_status: str = "To Do"
    rule: str = ""


class ImportRowResult(BaseModel):
    row_number: int
    identifier: str
    outcome: str  # "ok" | "rejected" | "conflict"
    action: str | None = None  # "create" | "update" -- set for ok/conflict only
    reason: str | None = None  # set for rejected only
    existing_rule_status: str | None = None  # set for conflict only: "Draft" | "Verified"
    # True when this identifier matches brdp_catalog for the PROJECT's
    # exact standard (docs request) -- a warning, not a rejection: the row
    # still imports, but Title/Definition come from the catalog, not the
    # file. Always False for a rejected row (nothing about it applies at
    # all, so there is nothing to override). Set unconditionally whenever
    # the identifier matches, even if the file's Title/Definition already
    # happen to equal the catalog's -- predictable, not conditional on
    # whether anything would actually change.
    catalog_override: bool = False
    # True when this row will REPLACE an existing Rule in Postgres with
    # different content (docs request, same pattern as catalog_override
    # above) -- a warning, not a rejection. Only ever set for action ==
    # "update" with a real, normalized-whitespace difference between the
    # file's Rule and the one already stored for this BRDP+format; a
    # brand-new BRDP (action == "create") or a re-import of the same Rule
    # (identical once normalized) has nothing to warn about. Never set for
    # the "conflict" outcome (file says "no rule" but one exists) -- that
    # case already has its own, unrelated warning via existing_rule_status.
    rule_override: bool = False


class ImportAnalyzeRequest(BaseModel):
    rows: list[ImportRowIn]


class ImportAnalyzeResponse(BaseModel):
    results: list[ImportRowResult]


class ImportApplyRequest(BaseModel):
    rows: list[ImportRowIn]
    # Applied uniformly to EVERY conflicting row at once (docs request: "un
    # único control... aplicado a TODAS las filas en conflicto a la vez"),
    # never per-row. Meaningless (and ignored) when there are no conflicts.
    conflict_resolution: str = "keep"  # "keep" | "clear"


class ImportApplyRowResult(BaseModel):
    row_number: int
    identifier: str
    # "created" | "updated" | "rejected" | "conflict_kept" | "conflict_cleared"
    outcome: str
    reason: str | None = None  # set for rejected only


class ImportApplyResultSummary(BaseModel):
    """The aggregate counts ProjectConfigPage.jsx's "Import complete" panel
    has always shown -- what used to be most of ImportApplyResponse before
    Apply became a background job. Persisted on ImportJob.result once the
    job finishes (docs request's column list didn't name this, but without
    it there is no way to show "N created / N updated / ..." once the job
    completes, which the badge's own "click through to see the in-progress
    result" requirement depends on -- disclosed as a necessary, minimal
    addition, not a silent scope change). The per-row list
    (ImportApplyRowResult) itself is intentionally NOT kept: the UI only
    ever rendered these 5 counts post-apply, never the per-row detail
    again (that's the analyze-phase summary's job).
    """

    created: int
    updated: int
    rejected: int
    conflicts_kept: int
    conflicts_cleared: int


class ImportApplyResponse(BaseModel):
    results: list[ImportApplyRowResult]
    created: int
    updated: int
    rejected: int
    conflicts_kept: int
    conflicts_cleared: int


class ImportJobAccepted(BaseModel):
    job_id: uuid.UUID


class ImportJobStatusOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    status: str  # "running" | "completed" | "failed"
    total_rows: int
    processed_rows: int
    validated_rows_total: int
    error: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    result: ImportApplyResultSummary | None = None
