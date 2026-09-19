import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class AppSettingsOut(BaseModel):
    apply_eta_ms_per_plain_row: int
    apply_eta_ms_per_validated_row: int
    apply_eta_validated_rows_threshold: int
    apply_eta_warning_seconds: int
    updated_at: datetime
    updated_by: uuid.UUID | None = None

    model_config = {"from_attributes": True}


class AppSettingsUpdate(BaseModel):
    # Same floor as the previous per-project inputs (min="0" in
    # ProjectConfigPage.jsx) -- a negative ms/threshold/seconds value has
    # no real meaning for this calculation.
    apply_eta_ms_per_plain_row: int = Field(ge=0)
    apply_eta_ms_per_validated_row: int = Field(ge=0)
    apply_eta_validated_rows_threshold: int = Field(ge=0)
    apply_eta_warning_seconds: int = Field(ge=0)
