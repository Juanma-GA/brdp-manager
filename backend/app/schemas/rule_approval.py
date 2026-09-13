import uuid
from datetime import datetime

from pydantic import BaseModel


class RuleApprovalPropose(BaseModel):
    rule_xml: str
    source: str = "llm"  # "llm" | "manual"
    # Defaults to pending_review server-side; pass "approved" only for a
    # manually written/reviewed rule (v1 parity: DetailPanel's manual edit
    # mode saves directly as approved, nothing left to re-review).
    status: str = "pending_review"


class RuleApprovalOut(BaseModel):
    rule_xml: str
    source: str
    status: str
    approved_at: datetime | None

    model_config = {"from_attributes": True}


class BulkRuleApprovalOut(BaseModel):
    brdp_id: uuid.UUID
    status: str

    model_config = {"from_attributes": True}


class BulkRuleApprovalWithRuleOut(BulkRuleApprovalOut):
    """Same shape as the bulk lookup above, plus the actual rule text --
    used only by Project Configuration's Export to Excel (Rule column).
    Kept as a separate response model (not an extra field bolted onto
    BulkRuleApprovalOut) so RecordsPage's bulk fetch, which only ever
    reads `.status` and runs on every Records page load, never grows its
    payload with rule_xml it doesn't use.
    """

    rule_xml: str
