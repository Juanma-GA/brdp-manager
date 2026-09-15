import uuid
from datetime import datetime

from pydantic import BaseModel


class TrashedBRDPOut(BaseModel):
    id: uuid.UUID
    identifier: str
    title: str
    project_id: uuid.UUID
    project_name: str
    deleted_at: datetime
    deleted_by_email: str | None = None

    model_config = {"from_attributes": True}
