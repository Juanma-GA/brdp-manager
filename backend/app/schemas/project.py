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

    model_config = {"from_attributes": True}
