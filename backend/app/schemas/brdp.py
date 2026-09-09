import uuid
from datetime import datetime

from pydantic import BaseModel


class BRDPCreate(BaseModel):
    identifier: str
    title: str = ""
    definition: str = ""
    proposal: str = ""
    validation: str = "Pending"
    comments: str = ""
    history: list = []


class BRDPUpdate(BaseModel):
    identifier: str | None = None
    title: str | None = None
    definition: str | None = None
    proposal: str | None = None
    validation: str | None = None
    comments: str | None = None
    history: list | None = None


class BRDPOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    identifier: str
    title: str
    definition: str
    proposal: str
    validation: str
    comments: str
    history: list
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
