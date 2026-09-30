import uuid

from pydantic import BaseModel

from app.schemas.rule_approval import RuleApprovalOut


class CompareCandidateOut(BaseModel):
    """The same BRDP (same identifier) in another project the user can see.
    rule_state is "todo" / "draft" / "verified" under that project's own
    rule format ("todo" also when its standard has none); last_test_result
    is None when the rule was never tested (or there is no rule).
    """

    brdp_id: uuid.UUID
    project_id: uuid.UUID
    project_name: str
    standard: str
    identifier: str
    title: str
    validation: str
    rule_format: str | None
    rule_state: str
    last_test_result: str | None
    last_test_up_to_date: bool | None


class CompareCandidatesOut(BaseModel):
    """GET .../compare-candidates. catalog_identifier says whether the
    BRDP's identifier is in the official catalog of the project's standard:
    when it is not (an EXT identifier, the project's own), other projects
    are never searched -- the same identifier there is a coincidence.
    """

    identifier: str
    standard: str
    catalog_identifier: bool
    same_brdp: list[CompareCandidateOut]


class CompareDetailOut(BaseModel):
    """GET .../compare-detail/{other_brdp_id}: everything the side-by-side
    view shows for one BRDP. rule is None when the BRDP has no rule under
    its project's format (or the standard has no rule format)."""

    brdp_id: uuid.UUID
    project_id: uuid.UUID
    project_name: str
    standard: str
    identifier: str
    title: str
    definition: str
    proposal: str
    validation: str
    comments: str
    rule_format: str | None
    rule: RuleApprovalOut | None
