import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.core.config import get_settings
from app.schemas.status_counts import ProposalStatusCounts, RuleStatusCounts

# A project name, as created, renamed, restored or duplicated: trimmed, never
# empty, at most project_name_max_chars characters (422 with the limit
# otherwise, never cut).
ProjectName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=get_settings().project_name_max_chars),
]


class ProjectCreate(BaseModel):
    name: ProjectName
    # e.g. "S1000D 4.2" -- fixed for the project's lifetime (docs/v2 §2).
    standard: str
    project_config: dict = {}
    # If true and brdp_catalog has rows for `standard`, seed the new
    # project with one real BRDP per catalog entry (identifier/title/
    # definition from the catalog, proposal empty, proposal_status
    # Pending). No-op if the catalog has no rows for this standard.
    seed_from_catalog: bool = False


class ProjectConfigUpdate(BaseModel):
    project_config: dict


class ProjectRename(BaseModel):
    # standard is deliberately absent here and everywhere else in the API --
    # fixed for the project's lifetime once created (docs/v2 §2), never
    # editable through any endpoint.
    name: ProjectName


class ProjectDuplicate(BaseModel):
    """POST /api/projects/{id}/duplicate: the copy's name -- the only thing
    the caller chooses; everything else is copied from the source."""

    model_config = ConfigDict(extra="forbid")

    name: ProjectName = Field(description="Name of the copy; must differ from every active project (ignoring case and accents).")


class ProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    standard: str
    project_config: dict
    created_at: datetime
    # Computed, not stored, and NOT the raw user_project_roles.role value:
    # "editor" | "viewer" -- the CALLER's effective capability on THIS
    # project. An admin has no user_project_roles row at all (the bypass in
    # docs/v2 §4.3), so a raw role would come back null and force every
    # frontend component to re-derive "treat admin as editor" on its own.
    # Instead the server resolves that once: effective_role is "editor" for
    # an admin, the real value from user_project_roles otherwise, and
    # "viewer" as the floor when neither applies. The frontend only ever
    # compares this single field (effective_role === 'editor'), never the
    # caller's global_role.
    effective_role: str
    # BRDP Projects' new Proposal Status/Rule Status columns -- one
    # aggregated query for every project in the response
    # (compute_status_counts(), app/repositories/brdp_repository.py),
    # never one query per project. A brand-new project with zero BRDPs
    # gets all-zero counts here, never a missing field.
    proposal_status_counts: ProposalStatusCounts
    rule_status_counts: RuleStatusCounts

    model_config = {"from_attributes": True}
