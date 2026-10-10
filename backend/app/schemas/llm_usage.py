import uuid
from datetime import date

from pydantic import BaseModel


class LlmUsageRow(BaseModel):
    """Calls of one user on one day (UTC), of one kind and result."""

    day: date
    user_id: uuid.UUID | None
    # None: an embedding job with no known user, or a user removed from the
    # table for good (the row outlives the user -- migration 0027).
    user_email: str | None
    user_deleted: bool
    kind: str
    result: str
    calls: int
    request_chars: int


class LlmUsageOut(BaseModel):
    days: int
    rows: list[LlmUsageRow]
