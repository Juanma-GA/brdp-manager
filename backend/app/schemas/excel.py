from pydantic import BaseModel, Field


class ExportRowIn(BaseModel):
    """One export row exactly as ProjectConfigPage.jsx's brdpToExportRow()
    builds it -- the server writes these values as they come and never
    recomputes a rule state (that logic, including S1000D 5.0/6.0 with no
    rule format -> "To Do" and an empty Rule, stays in the frontend)."""

    id: str = ""
    title: str = ""
    definition: str = ""
    proposal: str = ""
    proposalStatus: str = ""
    ruleStatus: str = ""
    rule: str = ""


class ExportRequest(BaseModel):
    rows: list[ExportRowIn] = Field(default_factory=list)
