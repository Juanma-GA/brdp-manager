"""Duplicar un proyecto: a snapshot copy of a project under another name.

copy_project_contents() copies, inside the caller's transaction and with
one INSERT ... SELECT per table (never a Python loop per row, so a
2 800-BRDP project is three statements):

- the active BRDPs (never the Papelera) with their texts, Proposal Status,
  refusal reason and their embedding + embedding_text_hash -- the copy has
  nothing pending to embed if the source had nothing, and Suggest works on
  it without calling Mistral;
- every rule_approvals row of those BRDPs, under any format, with its
  status, source, approval date, last test (result, reason, hash, edited
  examples, saved passed test) and dismissed correction -- a rule tested
  in the source shows "Tested ✓" in the copy, up to date (same rule text,
  same hash);
- ONE brdp_history row per new BRDP: field "copied_from", value
  {"project_id", "project_name", "standard"} of the source. The source's
  history is not copied.

Not copied: the Papelera, job rows (import, embeddings, extraction) and
AI Extract candidates, suggestion feedback, llm_calls and user roles.

New BRDPs are matched to their source rows by identifier, which is unique
among a project's active BRDPs (uq_brdps_project_id_identifier).
"""

import json
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User

_COPY_BRDPS = text(
    """
    INSERT INTO brdps (id, project_id, identifier, title, definition, proposal, validation, comments,
                       history, embedding, embedding_text_hash, created_at, updated_at)
    SELECT gen_random_uuid(), :new_id, identifier, title, definition, proposal, validation, comments,
           '[]'::jsonb, embedding, embedding_text_hash, now(), now()
    FROM brdps
    WHERE project_id = :source_id AND deleted_at IS NULL
    """
)

_COPY_RULES = text(
    """
    INSERT INTO rule_approvals (brdp_id, format, rule_xml, source, status, approved_at,
                                last_test_result, last_test_reason, last_test_at, last_test_by,
                                last_test_rule_hash, last_test_edited_examples, last_passed_test,
                                correction_dismissed_hash)
    SELECT nb.id, ra.format, ra.rule_xml, ra.source, ra.status, ra.approved_at,
           ra.last_test_result, ra.last_test_reason, ra.last_test_at, ra.last_test_by,
           ra.last_test_rule_hash, ra.last_test_edited_examples, ra.last_passed_test,
           ra.correction_dismissed_hash
    FROM rule_approvals ra
    JOIN brdps ob ON ob.id = ra.brdp_id AND ob.project_id = :source_id AND ob.deleted_at IS NULL
    JOIN brdps nb ON nb.project_id = :new_id AND nb.identifier = ob.identifier AND nb.deleted_at IS NULL
    """
)

_COPIED_FROM_HISTORY = text(
    """
    INSERT INTO brdp_history (id, brdp_id, user_id, user_email, field_name, old_value, new_value, changed_at)
    SELECT gen_random_uuid(), id, :user_id, :user_email, 'copied_from', '', :value, now()
    FROM brdps
    WHERE project_id = :new_id
    """
)


def copied_from_value(source_id: uuid.UUID, source_name: str, standard: str) -> str:
    """The "copied_from" History value: the source project as it was named
    when it was copied."""
    return json.dumps(
        {"project_id": str(source_id), "project_name": source_name, "standard": standard}, ensure_ascii=False
    )


async def copy_project_contents(
    db: AsyncSession, *, source_id: uuid.UUID, source_name: str, standard: str, new_id: uuid.UUID, actor: User
) -> dict:
    """Copies the source's active BRDPs, their rules and one "copied_from"
    History entry each into new_id. Does not commit. Returns the counts."""
    params = {"source_id": source_id, "new_id": new_id}
    brdps = (await db.execute(_COPY_BRDPS, params)).rowcount
    rules = (await db.execute(_COPY_RULES, params)).rowcount
    await db.execute(
        _COPIED_FROM_HISTORY,
        {
            "new_id": new_id,
            "user_id": actor.id,
            "user_email": actor.email,
            "value": copied_from_value(source_id, source_name, standard),
        },
    )
    return {"brdp_count": brdps, "rule_count": rules}
