import json
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from lxml import etree
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import error_detail
from app.api.deps import has_project_role, require_project_role
from app.api.routes.brdps import _get_owned_brdp
from app.db.base import get_db
from app.models import BRDP, Project, RuleApproval, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.schemas.rule_approval import (
    BulkRuleApprovalOut,
    BulkRuleApprovalWithRuleOut,
    RuleApprovalOut,
    RuleApprovalPropose,
    RuleCorrectionDismiss,
    RuleTestRegister,
    rule_xml_hash,
)
from app.services.history import record_change
from app.services.rule_format_check import check_rule_format

router = APIRouter(
    prefix="/api/projects/{project_id}/brdps/{brdp_id}/approvals/{format}", tags=["approvals"]
)

# Separate router (no {brdp_id} segment) for the project-wide bulk lookup
# below -- APIRouter's prefix is fixed at construction, so it can't share
# `router` above.
project_router = APIRouter(prefix="/api/projects/{project_id}/approvals/{format}", tags=["approvals"])


def _project_approvals_stmt(project_id: uuid.UUID, format: str):
    """Shared by both bulk endpoints below -- the only difference between
    them is the response model (whether rule_xml is serialized out), never
    the query itself. ACTIVE_BRDP_FILTER: a trashed BRDP's rule_approvals
    row is left alive by a soft-delete (docs request), but must not
    surface here -- this feeds both RecordsPage's Rule Status column AND
    Export to Excel, both of which a deleted BRDP must disappear from.
    """
    return (
        select(RuleApproval)
        .join(BRDP, RuleApproval.brdp_id == BRDP.id)
        .where(BRDP.project_id == project_id, RuleApproval.format == format, ACTIVE_BRDP_FILTER)
    )


@project_router.get("", response_model=list[BulkRuleApprovalOut])
async def list_project_approvals(
    project_id: uuid.UUID,
    format: str,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> list[RuleApproval]:
    """Every rule-approval row for this project+format in one call -- powers
    RecordsPage's Rule Status column sort, which needs every row's status
    up front to sort the FULL dataset before pagination, not just fetch
    each visible row's own status independently the way RuleStatusCell
    does for display. A BRDP absent from the result has no approval row
    at all (frontend's ruleStateOf(null) => "todo", same convention the
    per-BRDP GET endpoint above already uses).
    """
    result = await db.execute(_project_approvals_stmt(project_id, format))
    return list(result.scalars().all())


@project_router.get("/export", response_model=list[BulkRuleApprovalWithRuleOut])
async def list_project_approvals_for_export(
    project_id: uuid.UUID,
    format: str,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> list[BulkRuleApprovalWithRuleOut]:
    """Same query as list_project_approvals above, but also returns
    rule_xml -- Project Configuration's Export to Excel needs the actual
    rule text for its Rule column (docs request), which the lean bulk
    endpoint deliberately omits. This is the JOIN with rule_approvals that
    export didn't have before: brdpToExportRow (ProjectConfigPage.jsx)
    looks up each BRDP's row here by brdp_id, same "absent row -> todo,
    empty rule" convention as everywhere else.
    """
    result = await db.execute(_project_approvals_stmt(project_id, format).add_columns(BRDP.identifier))
    # The BRDP's identifier too: the check of the project's rules for defects
    # (Records) names the other BRDP when two rules share an id, whatever
    # filter the Records list has.
    return [
        BulkRuleApprovalWithRuleOut.model_validate(approval).model_copy(update={"identifier": identifier})
        for approval, identifier in result.all()
    ]


def _rule_state(approval: RuleApproval | None) -> str:
    """Mirrors the frontend's ruleStateOf()/RULE_STATES (RecordsPage.jsx)
    exactly, "todo" included (no underscore -- matches the i18n table's
    records.rule.states.todo key, so the History section's formatHistoryValue()
    can translate it the same way the live stepper does). "todo" is not a
    DB value, it's the absence of a row. Used only to compute the
    audit-trail transition; never persisted on RuleApproval itself.
    """
    if approval is None:
        return "todo"
    return "verified" if approval.status == "approved" else "draft"


# Matches a qualified-name-shaped `prefix:local` occurrence (tag or
# attribute name) -- deliberately requires a letter/underscore start on
# BOTH sides so it can't mistake something like a bare "12:34" for a
# namespace prefix (an NCName can't start with a digit). See
# _wrap_rule_xml_fragment() for why this is needed.
_QNAME_RE = re.compile(r"\b([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)")


def _wrap_rule_xml_fragment(xml_text: str) -> str:
    """Wraps a Rule XML fragment in a throwaway <root> for parsing -- a
    rule_xml value here is always a fragment, never a full <?xml ...?>
    document, and since the rulesContext round it can legitimately have
    multiple XML-sibling roots (a loose structureObjectRule alongside one
    or more complete <contextRules rulesContext="..."> blocks in the same
    cell, e.g. BRDP-S1-00006). Confirmed empirically that lxml's
    etree.fromstring() otherwise rejects that with "Extra content at the
    end of the document" -- wrapping fixes it.

    Also declares (with a dummy, well-formedness-only URI) any namespace
    prefix the fragment actually USES but never declares itself --
    confirmed empirically necessary for real native Schematron content
    (<sch:pattern>/<sch:rule>/<sch:assert>): generateSchematronDITA.js's
    finalizeSchematronDocument() only ever declares xmlns:sch on the outer
    <sch:schema> wrapper, so an approved rule_xml fragment is only valid
    XML once embedded there -- checked standalone (here, or in
    _rule_xml_structurally_equal in import_jobs.py) it would otherwise
    fail with "Namespace prefix sch is not defined" even though the exact
    same content is perfectly well-formed in its real, final context.
    Detected generically by scanning for any `prefix:name` usage rather
    than hardcoding "sch" specifically -- so it also covers a BREX
    document using another prefix (e.g. "ns2", see brexToSchematron.js's
    _buildHeader for the same idea applied to a full assembled document
    instead of one fragment), and costs nothing for a prefix-free BREX
    fragment (no match -> no extra declaration, unchanged from before).
    """
    prefixes = {m.group(1) for m in _QNAME_RE.finditer(xml_text)} - {"xml", "xmlns"}
    ns_decls = "".join(f' xmlns:{p}="urn:x-wellformed-check:{p}"' for p in sorted(prefixes))
    return f"<root{ns_decls}>{xml_text}</root>"


def _xml_well_formed_error(xml_text: str) -> str | None:
    """Well-formedness only -- not a full XSD validation (that already
    happens later, in the browser, against the actual generated document).
    This exists because the manual rule editor is a NEW write path into
    rule_approvals that bypasses the generation engine entirely, so it
    also bypasses the engine's own checkWellFormed() safety net -- without
    this, a broken tag saved here would surface silently, later, inside a
    generated BREX/Schematron document instead of at save time. Mirrors
    the frontend's checkWellFormed() (src/api/generateBREX.js) so the API
    enforces the same rule even for a caller that skips the UI.

    See _wrap_rule_xml_fragment() for the fragment-wrapping/namespace
    details.
    """
    try:
        wrapped = xml_text if xml_text.lstrip().startswith("<?xml") else _wrap_rule_xml_fragment(xml_text)
        etree.fromstring(wrapped.encode("utf-8"))
        return None
    except etree.XMLSyntaxError as exc:
        return str(exc)


_XML_DECLARATION_RE = re.compile(r"^\s*<\?xml[^>]*\?>")


def _rule_format_problem(xml_text: str, format: str) -> dict | None:
    """check_rule_format on a well-formed rule_xml (a whole document is
    checked as a one-element fragment, without its XML declaration)."""
    fragment = _XML_DECLARATION_RE.sub("", xml_text, count=1)
    root = etree.fromstring(_wrap_rule_xml_fragment(fragment).encode("utf-8"))
    return check_rule_format(root, format)


@router.get("", response_model=RuleApprovalOut | None)
async def get_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval | None:
    """Read-only for viewer -- §4.3: viewer can see a project's rule
    approvals, just never propose/approve/revoke one (see the editor-gated
    endpoints below).
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    return await db.get(RuleApproval, (brdp_id, format))


@router.put("", response_model=RuleApprovalOut)
async def propose_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    body: RuleApprovalPropose,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    await _get_owned_brdp(project_id, brdp_id, db)
    xml_error = _xml_well_formed_error(body.rule_xml)
    if xml_error is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"rule_xml is not well-formed XML: {xml_error}",
        )
    # Consolidation C2, Part 0: well-formed is not enough -- the content must
    # contain a rule of this format (same check the interface runs first).
    format_problem = _rule_format_problem(body.rule_xml, format)
    if format_problem is not None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=format_problem["message"])
    copied_from = None
    if body.copied_from_brdp_id is not None:
        # "Usar esta Regla": the source must be an active BRDP the user can
        # see -- 404 otherwise, never revealing a project they have no role in.
        source_brdp = (
            await db.execute(select(BRDP).where(BRDP.id == body.copied_from_brdp_id, ACTIVE_BRDP_FILTER))
        ).scalar_one_or_none()
        if source_brdp is None or not await has_project_role(editor, source_brdp.project_id, "viewer", db):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source BRDP not found")
        source_project = await db.get(Project, source_brdp.project_id)
        copied_from = {
            "brdp_id": str(source_brdp.id),
            "identifier": source_brdp.identifier,
            "project_id": str(source_project.id),
            "project_name": source_project.name,
            "standard": source_project.standard,
        }
    # A copied rule always starts as Draft, whatever the request says: it
    # was verified in ANOTHER project, never in this one.
    if copied_from is not None:
        status_value = "pending_review"
    else:
        status_value = "approved" if body.status == "approved" else "pending_review"
    approval = await db.get(RuleApproval, (brdp_id, format))
    old_state = _rule_state(approval)
    old_rule_xml = approval.rule_xml if approval is not None else ""
    if approval is None:
        approval = RuleApproval(brdp_id=brdp_id, format=format)
        db.add(approval)
    approval.rule_xml = body.rule_xml
    approval.source = body.source
    approval.status = status_value
    approval.approved_at = datetime.now(timezone.utc) if status_value == "approved" else None
    record_change(db, brdp_id, editor, "rule_status", old_state, _rule_state(approval))
    # The rule TEXT too (Suggest Rule adjustments round): replacing one
    # Draft with another leaves the status unchanged, and would otherwise
    # leave no trace at all. record_change skips an unchanged text.
    record_change(db, brdp_id, editor, "rule", old_rule_xml, approval.rule_xml)
    if copied_from is not None:
        # An event, like "rule_test": recorded even when the text is the same.
        record_change(
            db, brdp_id, editor, "rule_copied", "", json.dumps(copied_from, sort_keys=True, ensure_ascii=False), always=True
        )
    if body.correction is not None:
        # Corrección propuesta: what the accepted correction fixed (and what
        # it left), as codes -- the "rule" entry above has the old and new text.
        record_change(
            db,
            brdp_id,
            editor,
            "rule_corrected",
            "",
            json.dumps(body.correction.model_dump(), sort_keys=True, ensure_ascii=False),
            always=True,
        )
    await db.commit()
    await db.refresh(approval)
    return approval


def _rule_test_history_value(
    result: str | None,
    reason: dict | None,
    edited_examples: list | None = None,
    kept_test_at: datetime | None = None,
    examples_from: datetime | None = None,
) -> str:
    """The History value of a "rule_test" entry: the result and its reason
    as JSON codes (never a sentence), so the History panel translates it in
    the viewer's language. "" for "not tested" (a rule's first test). A
    test passed with examples edited by hand also carries them
    ("edited_examples": [{"label", "xml"}]), so History can show their XML;
    without them the value is exactly as before.
    """
    if result is None:
        return ""
    value = {"result": result, "reason": reason}
    if edited_examples:
        value["edited_examples"] = edited_examples
    # A result the user chose not to record, keeping the passed test of
    # that date ("Mantener la anterior").
    if kept_test_at is not None:
        value["not_recorded"] = True
        value["kept_test_at"] = kept_test_at.isoformat()
    # A test run on the saved examples of an earlier passed test ("Probar
    # con los ejemplos guardados"): the date of the test they come from.
    if examples_from is not None:
        value["examples_from"] = examples_from.isoformat()
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


@router.post("/test", response_model=RuleApprovalOut)
async def register_rule_test(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    body: RuleTestRegister,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    """Records the result of a "Test rule" run on the SAVED rule (Test de
    reglas T3). The frontend sends the SHA-256 of the rule_xml it tested;
    it must match the saved rule_xml, so a result is never attached to a
    rule it was not computed for (a stale panel, a suggestion that was
    replaced before Accept) -- 409 otherwise.

    What is recorded is the verdict of the examples as the LLM wrote them
    and the application validated them (after the one correction round):
    editing an example and pressing "Run again" in the panel is a
    what-if for the user and never changes the recorded result -- except
    once per generation, when the edits turn a recorded test that was not
    passed into "Correct": that is recorded as passed with the edited
    examples (edited_examples; see useRuleTest.js). Editor only: a viewer can run Test rule (it writes
    nothing), but only an editor's run is recorded.

    Always adds a "rule_test" History entry, even with the same result as
    before (history.record_change(always=True)).

    keep_previous ("Mantener la anterior"): the recorded test passed and the
    user kept it over this new result -- the rule's test is left as it is
    and History notes the attempt as not recorded (409 if the last recorded
    test did not pass). The passed test may be of an earlier version of the
    rule: "Probar con los ejemplos guardados" re-runs it after the rule
    changed and asks before replacing it.

    passed_test (a passed result only): its examples, kept as the rule's
    last passed test (last_passed_test) -- replaced by the next passed test,
    left alone by any other result. A passed test recorded without them
    clears it: the examples kept would no longer be those of the last pass.
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_detail("rule_not_found", message="No rule found for this BRDP/format"),
        )
    if body.rule_hash != rule_xml_hash(approval.rule_xml):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_detail(
                "rule_test_outdated", message="The tested rule is not the saved rule; test the saved rule again"
            ),
        )
    reason = body.reason.model_dump() if body.reason is not None else None
    edited = [e.model_dump() for e in body.edited_examples] if body.edited_examples else None
    old_value = _rule_test_history_value(
        approval.last_test_result, approval.last_test_reason, approval.last_test_edited_examples
    )
    if body.keep_previous:
        # "Mantener la anterior": only over a passed test (of this rule or,
        # re-running its saved examples, of an earlier version of it).
        if approval.last_test_result != "passed":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=error_detail("rule_test_nothing_to_keep", message="There is no passed test of this rule to keep"),
            )
        record_change(
            db,
            brdp_id,
            editor,
            "rule_test",
            old_value,
            _rule_test_history_value(body.result, reason, kept_test_at=approval.last_test_at),
            always=True,
        )
        await db.commit()
        await db.refresh(approval)
        return approval
    approval.last_test_result = body.result
    approval.last_test_reason = reason
    approval.last_test_at = datetime.now(timezone.utc)
    approval.last_test_by = editor.id
    approval.last_test_rule_hash = body.rule_hash
    approval.last_test_edited_examples = edited
    examples_from = body.passed_test.examples_from if body.passed_test is not None else None
    if body.result == "passed":
        approval.last_passed_test = (
            {
                "at": approval.last_test_at.isoformat(),
                "rule_xml": approval.rule_xml,
                "rule_hash": body.rule_hash,
                "proposal": body.passed_test.proposal,
                "examples_from": examples_from.isoformat() if examples_from is not None else None,
                "edited_count": len(edited) if edited else body.passed_test.edited_count,
                "examples": [e.model_dump(by_alias=True) for e in body.passed_test.examples],
            }
            if body.passed_test is not None
            else None
        )
    record_change(
        db,
        brdp_id,
        editor,
        "rule_test",
        old_value,
        _rule_test_history_value(body.result, reason, edited, examples_from=examples_from),
        always=True,
    )
    await db.commit()
    await db.refresh(approval)
    return approval


@router.post("/correction-dismissal", response_model=RuleApprovalOut)
async def dismiss_rule_correction(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    body: RuleCorrectionDismiss,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    """Corrección propuesta, "Descartar": the correction proposed for the
    saved rule text does not come back for that text (it is remembered by
    the text's SHA-256). The rule itself never changes here. 409 when the
    hash is not the saved rule's -- the correction was of another text.
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_detail("rule_not_found", message="No rule found for this BRDP/format"),
        )
    if body.rule_hash != rule_xml_hash(approval.rule_xml):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_detail(
                "rule_correction_outdated", message="The rule changed since the correction was proposed; open it again"
            ),
        )
    approval.correction_dismissed_hash = body.rule_hash
    await db.commit()
    await db.refresh(approval)
    return approval


@router.post("/approve", response_model=RuleApprovalOut)
async def approve_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    await _get_owned_brdp(project_id, brdp_id, db)
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is None or approval.status != "pending_review":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_detail("rule_not_draft", message="No pending_review approval found for this BRDP/format"),
        )
    approval.status = "approved"
    approval.approved_at = datetime.now(timezone.utc)
    record_change(db, brdp_id, editor, "rule_status", "draft", "verified")
    await db.commit()
    await db.refresh(approval)
    return approval


@router.post("/revoke", response_model=RuleApprovalOut)
async def revoke_approval_status(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    """Rule Status stepper's Verified -> Draft action: flips an approved
    rule back to pending_review while PRESERVING rule_xml/source --
    nothing is deleted, so the text that was actually reviewed is never
    lost. This is intentional (docs request
    item 2): Edit is unavailable directly on an approved rule precisely so
    a Verified rule can never end up with different text than what was
    reviewed, without needing auto-revocation logic on edit.
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is None or approval.status != "approved":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_detail("rule_not_verified", message="No approved approval found for this BRDP/format"),
        )
    approval.status = "pending_review"
    approval.approved_at = None
    record_change(db, brdp_id, editor, "rule_status", "verified", "draft")
    await db.commit()
    await db.refresh(approval)
    return approval
