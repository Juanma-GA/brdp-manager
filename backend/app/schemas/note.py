from datetime import datetime

from pydantic import BaseModel


class NoteUpdate(BaseModel):
    text: str


class NoteOut(BaseModel):
    text: str
    updated_at: datetime

    model_config = {"from_attributes": True}
