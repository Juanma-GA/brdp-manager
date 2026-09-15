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


class TrashBulkDeleteRequest(BaseModel):
    brdp_ids: list[uuid.UUID]


class TrashBulkDeleteResult(BaseModel):
    # An id in `not_found` is not an error -- most commonly it means the
    # row was already restored (by someone else, or by this same admin in
    # another tab) between when the checkbox was ticked and this request
    # -- the real race docs request calls out explicitly. The batch still
    # deletes everything it validly can rather than aborting over it.
    deleted: list[uuid.UUID]
    not_found: list[uuid.UUID]
