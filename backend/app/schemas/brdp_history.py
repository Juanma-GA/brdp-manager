import uuid
from datetime import datetime

from pydantic import BaseModel


class BRDPHistoryOut(BaseModel):
    id: uuid.UUID
    field_name: str
    old_value: str
    new_value: str
    user_email: str
    changed_at: datetime

    model_config = {"from_attributes": True}
