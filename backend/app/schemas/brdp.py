import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import get_settings
from app.core.text import NormalizedText

# The Proposal Status values the app uses (AACF 1, Part 5). The column has
# no CHECK constraint: the Excel import keeps its own handling of other
# values (rows "imported with a warning").
ProposalStatus = Literal["Pending", "Validated", "Refused"]

_settings = get_settings()
_TITLE_MAX = _settings.brdp_title_max_chars
_TEXT_MAX = _settings.brdp_text_max_chars


class BRDPCreate(BaseModel):
    # Texts are stored with LF line endings (app/core/text.py).
    # Any other field -- `history` among them, which is written only by the
    # server -- is refused with a 422 (extra_forbidden).
    model_config = ConfigDict(extra="forbid")

    identifier: str
    title: NormalizedText = Field(default="", max_length=_TITLE_MAX)
    definition: NormalizedText = Field(default="", max_length=_TEXT_MAX)
    proposal: NormalizedText = Field(default="", max_length=_TEXT_MAX)
    validation: ProposalStatus = "Pending"
    comments: NormalizedText = Field(default="", max_length=_TEXT_MAX)


class BRDPUpdate(BaseModel):
    # identifier is deliberately absent -- a BRDP's identifier is fixed for
    # its lifetime once created (BRDPCreate still takes it), never editable
    # afterward under any circumstance. Same pattern as MeUpdate leaving
    # out global_role (schemas/auth.py): structurally impossible to send,
    # not just hidden in the UI. `history` is refused too (extra_forbidden).
    # Each field may be left out; sent, it must be a value (a null used to
    # reach the NOT NULL column as a 500). Over its limit the request is
    # refused with the limit -- never cut (HR6). A BRDP already saved with a
    # longer text is read and exported as before; only an edit of that field
    # asks to shorten it.
    model_config = ConfigDict(extra="forbid")

    title: NormalizedText = Field(default=None, max_length=_TITLE_MAX)
    definition: NormalizedText = Field(default=None, max_length=_TEXT_MAX)
    proposal: NormalizedText = Field(default=None, max_length=_TEXT_MAX)
    validation: ProposalStatus = None
    comments: NormalizedText = Field(default=None, max_length=_TEXT_MAX)


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
    # The other S1000D edition whose catalog has this identifier when the
    # catalog of the project's standard does not ("S1000D 4.1"), else None.
    # Computed per response (app/api/routes/brdps.py's _with_catalog_edition),
    # never stored.
    catalog_edition: str | None = None

    model_config = {"from_attributes": True}
