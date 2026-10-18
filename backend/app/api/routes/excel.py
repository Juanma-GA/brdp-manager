"""Excel files on the server (app/services/excel_io.py): the project export
and the generic template. The import's parse step lives with the rest of
the import (routes/brdp_import.py)."""

import json
import uuid

from fastapi import APIRouter, Depends, Response

from app.api.deps import get_current_user, require_project_role
from app.models import User
from app.schemas.excel import ExportRequest
from app.services.excel_io import XLSX_MEDIA_TYPE, build_export, build_generic_template

router = APIRouter(tags=["excel"])

# The cells the export wrote as the omitted-cell marker, for the page to
# name: JSON {"total": N, "cells": [{"id", "field"}, ...]} in this header
# (ASCII-only). Kept well under a proxy's response-header buffer (nginx:
# 4-8 KB by default): when the list does not fit, "cells" holds the first
# ones and "total" still says how many there are -- the page shows "and N
# more", never a silently shorter list.
OMITTED_CELLS_HEADER = "X-Export-Omitted-Cells"
_OMITTED_CELLS_HEADER_MAX_BYTES = 3000


def omitted_cells_header(cells: list[dict]) -> str:
    listed = [{"id": c["id"], "field": c["field"]} for c in cells]
    while True:
        value = json.dumps({"total": len(cells), "cells": listed}, ensure_ascii=True, separators=(",", ":"))
        if len(value) <= _OMITTED_CELLS_HEADER_MAX_BYTES or not listed:
            return value
        listed = listed[: len(listed) // 2]


def _xlsx_response(content: bytes, filename: str, headers: dict | None = None) -> Response:
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"', **(headers or {})},
    )


@router.post("/api/projects/{project_id}/export.xlsx")
async def export_project_xlsx(
    project_id: uuid.UUID,
    body: ExportRequest,
    _viewer: User = Depends(require_project_role("viewer")),
) -> Response:
    """Export to Excel. The body is the rows the page already built
    (brdpToExportRow), written as they come: ID, Title, Definition,
    Proposal, Proposal Status, Rule Status, Rule, sheet "BRDPs".

    A cell over Excel's 32,767-character limit is never cut and never
    refuses the export: the file holds OMITTED_CELL_MARKER in that cell
    (excel_io.py) -- the import reads it back as "unchanged" -- and the
    response names each such cell in the X-Export-Omitted-Cells header.
    A project with no such cell gets the same file as always, with no
    header. Viewer-readable, like everything a project member can already
    see."""
    content, omitted = build_export([row.model_dump() for row in body.rows])
    headers = {OMITTED_CELLS_HEADER: omitted_cells_header(omitted)} if omitted else None
    return _xlsx_response(content, "brdps-export.xlsx", headers)


@router.get("/api/brdp-template.xlsx")
async def generic_template_xlsx(_current_user: User = Depends(get_current_user)) -> Response:
    """The generic Excel template, for a standard with no curated template
    of its own in public/ (S1000D 5.0/6.0): the 10 example rows the
    frontend's generateTemplate() used to build. Any signed-in user."""
    return _xlsx_response(build_generic_template(), "brdp-template.xlsx")
