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


class ImportApplyResponse(BaseModel):
    results: list[ImportApplyRowResult]
    created: int
    updated: int
    rejected: int
    conflicts_kept: int
    conflicts_cleared: int
