import uuid

from pydantic import BaseModel


class BRDPCatalogEntryOut(BaseModel):
    id: uuid.UUID
    identifier: str
    title: str
    definition: str

    model_config = {"from_attributes": True}


class BRDPCatalogCountOut(BaseModel):
    standard: str
    count: int
