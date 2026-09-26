from fastapi import APIRouter, Depends, Query

from app.api.deps import get_current_user
from app.models import User
from app.schemas.schema_cards import SchemaCardsOut
from app.services.schema_cards import get_schema_cards

router = APIRouter(prefix="/api/schema-cards", tags=["schema-cards"])


@router.get("", response_model=SchemaCardsOut)
async def read_schema_cards(
    standard: str = Query(...),
    names: str = Query(..., description="Comma-separated element names to look up."),
    _current_user: User = Depends(get_current_user),
) -> SchemaCardsOut:
    """Docs request ("Servicio de fichas de esquema"): structural facts
    (attributes with required/enum, direct children) for the requested
    element names, from the real XSD-derived cards
    (backend/schema_cards/*.json, loaded once at startup -- see
    app.services.schema_cards). Any authenticated user can read this --
    it's reference data about a standard, not project-scoped or secret,
    same posture as GET /api/config/ai-provider.
    """
    name_list = [n.strip() for n in names.split(",") if n.strip()]
    available, cards, unknown = get_schema_cards(standard, name_list)
    return SchemaCardsOut(standard=standard, available=available, cards=cards, unknown=unknown)
