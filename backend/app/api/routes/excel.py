"""Excel files on the server (app/services/excel_io.py): the project export
and the generic template. The import's parse step lives with the rest of
the import (routes/brdp_import.py)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.api.deps import get_current_user, require_project_role
from app.models import User
from app.schemas.excel import ExportRequest
from app.services.excel_io import (
    EXCEL_CELL_CHAR_LIMIT,
    XLSX_MEDIA_TYPE,
    ExportCellTooLarge,
    build_export_workbook,
    build_generic_template,
)

router = APIRouter(tags=["excel"])


def _xlsx_response(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
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

    A cell over Excel's 32,767-character limit refuses the whole export
    with a 422 naming each BRDP and field ({"code": "cell_too_large",
    "limit", "cells": [{"id", "field", "length"}], "message"}) -- nothing
    is cut (HR6/HR7). Viewer-readable, like everything a project member
    can already see."""
    try:
        content = build_export_workbook([row.model_dump() for row in body.rows])
    except ExportCellTooLarge as exc:
        listed = ", ".join(f"{c['id']} ({c['field']})" for c in exc.cells)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "cell_too_large",
                "limit": EXCEL_CELL_CHAR_LIMIT,
                "cells": exc.cells,
                "message": f"Content over Excel's {EXCEL_CELL_CHAR_LIMIT}-character cell limit: {listed}",
            },
        ) from exc
    return _xlsx_response(content, "brdps-export.xlsx")


@router.get("/api/brdp-template.xlsx")
async def generic_template_xlsx(_current_user: User = Depends(get_current_user)) -> Response:
    """The generic Excel template, for a standard with no curated template
    of its own in public/ (S1000D 5.0/6.0): the 10 example rows the
    frontend's generateTemplate() used to build. Any signed-in user."""
    return _xlsx_response(build_generic_template(), "brdp-template.xlsx")
