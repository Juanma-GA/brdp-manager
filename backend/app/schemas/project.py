import uuid
from datetime import datetime

from pydantic import BaseModel


class ProjectCreate(BaseModel):
    name: str
    # e.g. "S1000D 4.2" -- fixed for the project's lifetime (docs/v2 §2).
    standard: str
    project_config: dict = {}


class ProjectConfigUpdate(BaseModel):
    project_config: dict


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

    model_config = {"from_attributes": True}
