from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from lxml import etree
from pydantic import BaseModel

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.models import User

router = APIRouter(prefix="/api/validate-brex", tags=["validate-brex"])

# Each S1000D issue ships its own self-contained schema set (main BREX
# schema + xlink/rdf/dc companions it xs:imports) -- sets are NOT
# interchangeable between issues (server.js's BREX_XSD_MAP, mirrored here).
_BREX_XSD_MAP = {
    "3.0.1": ("S3.0.1", "brex.xsd"),
    "4.1": ("S4.1", "brex4.1.xsd"),
    "4.2": ("S4.2", "brex4.2.xsd"),
}


class ValidateBrexRequest(BaseModel):
    xml: str
    format: str


class ValidationError(BaseModel):
    message: str
    line: int | None
    raw_message: str


class ValidateBrexResponse(BaseModel):
    valid: bool
    errors: list[ValidationError]


@lru_cache
def _load_schema(format: str) -> etree.XMLSchema:
    """lxml/libxml2 has real filesystem access, unlike xmllint-wasm's
    virtual FS -- parsing the main XSD directly (all 4 files live in the
    same sources/S<issue>/ folder) lets its relative
    xs:import schemaLocation="xlink.xsd" etc. resolve on their own via the
    document's base URI. No manual preloading needed.
    """
    entry = _BREX_XSD_MAP.get(format)
    if entry is None:
        raise KeyError(format)
    subdir, filename = entry
    path = Path(get_settings().sources_dir) / subdir / filename
    doc = etree.parse(str(path))
    return etree.XMLSchema(doc)


@router.post("", response_model=ValidateBrexResponse)
async def validate_brex(
    body: ValidateBrexRequest, _current_user: User = Depends(get_current_user)
) -> ValidateBrexResponse:
    if body.format not in _BREX_XSD_MAP:
        raise HTTPException(
            status_code=400,
            detail=f'Unknown format "{body.format}". Expected one of: 3.0.1, 4.1, 4.2',
        )

    try:
        schema = _load_schema(body.format)
    except OSError as err:
        raise HTTPException(
            status_code=500, detail=f'Could not load XSD schema files for format "{body.format}": {err}'
        )

    try:
        doc = etree.fromstring(body.xml.encode("utf-8"))
    except etree.XMLSyntaxError as err:
        return ValidateBrexResponse(
            valid=False,
            errors=[ValidationError(message=str(err), line=err.lineno, raw_message=str(err))],
        )

    valid = schema.validate(doc)
    errors = [
        ValidationError(message=e.message, line=e.line, raw_message=str(e)) for e in schema.error_log
    ]
    return ValidateBrexResponse(valid=valid, errors=errors)
