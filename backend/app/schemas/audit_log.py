import uuid
from datetime import datetime

from pydantic import BaseModel


class AuditLogRow(BaseModel):
    """One administrative action (Protecciones 2b). Ids without a foreign
    key: the user, project or BRDP may no longer exist; the emails, names
    and labels are as they were when the action was done."""

    id: uuid.UUID
    created_at: datetime
    actor_id: uuid.UUID | None
    actor_email: str
    action: str
    target_type: str
    target_id: uuid.UUID | None
    target_label: str
    project_id: uuid.UUID | None
    project_name: str | None
    detail: dict

    model_config = {"from_attributes": True}


class AuditLogOut(BaseModel):
    days: int
    limit: int
    # True when more rows matched than `limit`: only the most recent are here.
    truncated: bool
    rows: list[AuditLogRow]
