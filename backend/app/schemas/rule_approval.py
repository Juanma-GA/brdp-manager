import json
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field, field_validator, model_validator

from app.services.rule_test_category import rule_test_category, rule_xml_hash  # noqa: F401 (re-exported)

# Where a rule_approvals row's rule_xml came from:
#   "llm"          -- generated inside this app (Suggest Rule's Accept).
#   "manual"       -- written/edited by a person (the rule editor, Excel import).
#   "external_llm" -- produced by an LLM OUTSIDE this app from Suggest Rule's
#                     "Copy prompt", then pasted back via "Paste rule"
#                     (docs request, Suggest Rule round) -- kept distinct
#                     from "llm" so in-app and out-of-app generations can be
#                     told apart later.
#   "copied"       -- brought from another BRDP ("Comparar dos BRDP lado a
#                     lado": "Usar esta Regla"), of this project or another.
#   "extracted"    -- read from an existing BREX/Schematron (AI Extract 1/2).
RuleSource = Literal["llm", "manual", "external_llm", "copied", "extracted"]


class RuleApprovalPropose(BaseModel):
    rule_xml: str
    source: RuleSource = "llm"
    # Defaults to pending_review server-side; pass "approved" only for a
    # manually written/reviewed rule (nothing left to re-review).
    status: str = "pending_review"
    # "Usar esta Regla": the BRDP the rule was copied from. History gets a
    # "rule_copied" event naming its project and identifier (read from the
    # database, never from the client); the user must be able to see it.
    copied_from_brdp_id: uuid.UUID | None = None
    # Corrección propuesta: the rule saved is a correction the person
    # accepted. History gets a "rule_corrected" event with what was fixed
    # (codes, never sentences) besides the change of the rule text.
    correction: "RuleCorrectionRecord | None" = None


# A proposed correction as History records it: each fix with the defect it
# fixes ({code, params, fix}) and what is still wrong after it -- codes
# from src/validation/ruleCorrection.js, translated by the interface.
_MAX_CORRECTION_ITEMS = 50
_MAX_CORRECTION_JSON = 20000


class RuleCorrectionItem(BaseModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)
    params: dict[str, Any] = Field(default_factory=dict)
    fix: dict[str, Any] | None = None


class RuleCorrectionRecord(BaseModel):
    fixes: list[RuleCorrectionItem] = Field(min_length=1, max_length=_MAX_CORRECTION_ITEMS)
    remaining: list[RuleCorrectionItem] = Field(default_factory=list, max_length=_MAX_CORRECTION_ITEMS)

    @model_validator(mode="after")
    def _size(self) -> "RuleCorrectionRecord":
        if len(json.dumps(self.model_dump())) > _MAX_CORRECTION_JSON:
            raise ValueError("correction is too large")
        return self


class RuleCorrectionDismiss(BaseModel):
    # SHA-256 hex of the rule_xml the discarded correction was proposed
    # for; must be the saved rule's (409 otherwise).
    rule_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


# Test de reglas T3: the recorded result of the last "Test rule" run.
#   passed         -- the engine agreed with every example (verdict correct)
#   review         -- the examples passed, but the rule does not seem to
#                     implement the Proposal (the LLM's proposalMismatch note);
#                     never counted as passed
#   failed         -- it accepted an example meant to violate the rule, or
#                     rejected one meant to comply
#   inconclusive   -- nothing selected, no accept+reject pair ran, or no
#                     example passed validation
#   not_executable -- the engine cannot run the rule (document(), a
#                     nonContextRule, an XPath error...)
RuleTestResult = Literal["passed", "review", "failed", "inconclusive", "not_executable"]

# A reason's serialized size cap: a code plus a few short params (an XPath
# error message, a rule id per part). Generous, only there so the column
# never stores an arbitrary payload.
_MAX_REASON_JSON = 4000


class RuleTestReason(BaseModel):
    """A reason as a code and its parameters, never a sentence -- the UI
    translates it (records.ruleTest.reasons.<code>) in the viewer's own
    language, so History and the Rule Status indicator follow a language
    switch. Codes are the frontend's (src/utils/ruleTestReasons.js); the
    backend only checks the shape.
    """

    code: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)
    params: dict[str, Any] = Field(default_factory=dict)


# An example edited by hand in the Test rule panel, as it was run: its
# label and its complete XML (skeleton + content). Caps only there so the
# column never stores an arbitrary payload.
_MAX_EDITED_EXAMPLES = 20
_MAX_EDITED_XML = 50000


class RuleTestEditedExample(BaseModel):
    label: str = Field(max_length=500)
    xml: str = Field(min_length=1, max_length=_MAX_EDITED_XML)


# The examples of a passed test, kept with it ("Ver prueba aprobada",
# "Probar con los ejemplos guardados"): each example that ran, as it ran --
# the complete document (skeleton + content + metadata), what it expected
# and what the engine gave. Caps only there so the column never stores an
# arbitrary payload.
_MAX_PASSED_EXAMPLES = 50
_MAX_PASSED_PATHS = 500
_MAX_PROPOSAL = 20000


class RuleTestPassedExample(BaseModel):
    label: str = Field(default="", max_length=500)
    expected: Literal["accept", "reject"]
    schema_: str | None = Field(default=None, alias="schema", max_length=100)
    xml: str = Field(min_length=1, max_length=_MAX_EDITED_XML)
    # The nodes the application built (dimmed in the panel).
    skeleton_node_paths: list[str] = Field(default_factory=list, max_length=_MAX_PASSED_PATHS)
    result: Literal["accepted", "rejected"]
    matches: bool

    model_config = {"populate_by_name": True}


class RuleTestPassedTest(BaseModel):
    examples: list[RuleTestPassedExample] = Field(min_length=1, max_length=_MAX_PASSED_EXAMPLES)
    # The Proposal the examples were written for: re-running them after the
    # Proposal changed warns that they may no longer test the decision.
    proposal: str = Field(default="", max_length=_MAX_PROPOSAL)
    # A test passed by re-running the saved examples of an earlier test
    # ("Probar con los ejemplos guardados"): the date of the test the
    # examples come from. None for examples generated for this test.
    examples_from: datetime | None = None
    # How many of those examples were edited by hand in the test they come
    # from (a re-run keeps saying so; the edited XML itself stays in that
    # test's History entry).
    edited_count: int = Field(default=0, ge=0, le=_MAX_PASSED_EXAMPLES)


class RuleTestRegister(BaseModel):
    result: RuleTestResult
    reason: RuleTestReason | None = None
    # A passed test reached by editing examples by hand after the recorded
    # test was not passed (the panel records it once per generation). Only
    # with result "passed"; never an empty list.
    edited_examples: list[RuleTestEditedExample] | None = Field(default=None, max_length=_MAX_EDITED_EXAMPLES)
    # SHA-256 hex of the rule_xml that was tested; must match the saved
    # rule_xml (otherwise the test was of another rule -- 409).
    rule_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    # "Mantener la anterior": the last recorded test passed and the user
    # chose to keep it over this new, not-passed result. Nothing on the
    # rule changes; History notes the attempt as not recorded. Only for a
    # result other than "passed" (a passed test is always recorded).
    keep_previous: bool = False
    # A passed test's examples, kept as the rule's last passed test. Only
    # with result "passed".
    passed_test: RuleTestPassedTest | None = None

    @field_validator("reason")
    @classmethod
    def _reason_size(cls, reason: RuleTestReason | None) -> RuleTestReason | None:
        if reason is not None and len(json.dumps(reason.model_dump())) > _MAX_REASON_JSON:
            raise ValueError("reason is too large")
        return reason

    @model_validator(mode="after")
    def _reason_matches_result(self) -> "RuleTestRegister":
        # A passed test has nothing to explain; every other result does.
        if self.result == "passed" and self.reason is not None:
            raise ValueError("a passed test has no reason")
        if self.result != "passed" and self.reason is None:
            raise ValueError(f"a {self.result} test needs a reason")
        if self.keep_previous and self.result == "passed":
            raise ValueError("a passed test is always recorded; keep_previous is for another result")
        if self.edited_examples is not None:
            if self.result != "passed":
                raise ValueError("only a passed test is recorded with edited examples")
            if not self.edited_examples:
                raise ValueError("edited_examples, when given, is not empty")
        if self.passed_test is not None and self.result != "passed":
            raise ValueError("only a passed test is kept with its examples")
        return self


class RuleApprovalOut(BaseModel):
    rule_xml: str
    source: str
    status: str
    approved_at: datetime | None
    last_test_result: str | None = None
    last_test_reason: dict[str, Any] | None = None
    last_test_at: datetime | None = None
    last_test_rule_hash: str | None = None
    last_test_edited_examples: list[dict[str, Any]] | None = None
    # The last passed test with its examples (see the model).
    last_passed_test: dict[str, Any] | None = None
    # Corrección propuesta: the rule text whose correction was discarded.
    correction_dismissed_hash: str | None = None

    model_config = {"from_attributes": True}

    @computed_field
    @property
    def test_category(self) -> str:
        """What the test means now, for the Rule Status indicator -- the same
        function the Records header counts with (services/rule_test_category.py)."""
        return rule_test_category(self.last_test_result, self.last_test_rule_hash, rule_xml_hash(self.rule_xml))

    @computed_field
    @property
    def last_test_up_to_date(self) -> bool | None:
        """None when never tested (or a test the app cannot read); False when
        the rule changed since the test ("Test outdated"); True when the
        tested rule is the saved one. Derived from test_category."""
        category = self.test_category
        if category == "not_tested":
            return None
        return category != "outdated"


class BulkRuleApprovalOut(BaseModel):
    brdp_id: uuid.UUID
    status: str

    model_config = {"from_attributes": True}


class BulkRuleApprovalWithRuleOut(BulkRuleApprovalOut):
    """Same shape as the bulk lookup above, plus the actual rule text --
    used by Project Configuration's Export to Excel (Rule column), Generate,
    and the check of the project's rules for defects in Records.
    Kept as a separate response model (not an extra field bolted onto
    BulkRuleApprovalOut) so RecordsPage's bulk fetch, which only ever
    reads `.status` and runs on every Records page load, never grows its
    payload with rule_xml it doesn't use.
    """

    rule_xml: str
    # Corrección propuesta: Records checks every saved rule for defects and
    # needs to know which rule texts had their correction discarded.
    correction_dismissed_hash: str | None = None
    identifier: str | None = None


RuleApprovalPropose.model_rebuild()
