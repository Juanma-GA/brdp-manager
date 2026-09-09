import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_project_role
from app.api.routes.brdps import _get_owned_brdp
from app.db.base import get_db
from app.models import Note, User
from app.schemas.note import NoteOut, NoteUpdate

router = APIRouter(prefix="/api/projects/{project_id}/brdps/{brdp_id}/notes", tags=["notes"])


@router.get("", response_model=NoteOut)
async def get_note(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> NoteOut:
    await _get_owned_brdp(project_id, brdp_id, db)
    note = await db.get(Note, brdp_id)
    if note is None:
        # v1 parity (GET /api/notes/:brdpId): no row yet means an empty
        # note, not a 404 -- the UI always has something to render.
        return NoteOut(text="", updated_at=datetime.now(timezone.utc))
    return note


@router.put("", response_model=NoteOut)
async def upsert_note(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    body: NoteUpdate,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> Note:
    await _get_owned_brdp(project_id, brdp_id, db)
    note = await db.get(Note, brdp_id)
    if note is None:
        note = Note(brdp_id=brdp_id, text=body.text)
        db.add(note)
    else:
        note.text = body.text
    await db.commit()
    await db.refresh(note)
    return note
