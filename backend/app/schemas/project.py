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
    # Computed, not stored: "admin" | "editor" | "viewer" for the CALLER on
    # THIS project. Added so the frontend can hide edit controls it has no
    # right to use (docs/v2 §5: "el frontend oculta, el backend impide") --
    # without this the UI would have to guess, or render editable controls
    # optimistically and only find out via a failed PUT.
    my_role: str

    model_config = {"from_attributes": True}
