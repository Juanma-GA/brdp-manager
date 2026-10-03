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
    # identifier is deliberately absent -- a BRDP's identifier is fixed for
    # its lifetime once created (BRDPCreate still takes it), never editable
    # afterward under any circumstance. Same pattern as MeUpdate leaving
    # out global_role (schemas/auth.py): structurally impossible to send,
    # not just hidden in the UI.
    title: str | None = None
    definition: str | None = None
    proposal: str | None = None
    validation: str | None = None
    comments: str | None = None
    history: list | None = None


class NextExtIdentifierOut(BaseModel):
    identifier: str


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
