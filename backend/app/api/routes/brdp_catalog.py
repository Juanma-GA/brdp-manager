from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.base import get_db
from app.models import BRDPCatalog, User
from app.schemas.brdp_catalog import BRDPCatalogCountOut, BRDPCatalogEntryOut

router = APIRouter(prefix="/api/brdp-catalog", tags=["brdp-catalog"])

# Global reference data, not scoped to any project -- gated only on being
# a real authenticated user (any role), same as the rest of read-only
# lookup data in this app. Used from two different, unrelated contexts:
# Create Project (to show "Seed with official catalog (N items)" before
# any project/role exists yet) and Records' Add BRDP catalog picker
# (inside an existing project, for whichever role can see that page).

# "Schematron 1.0 — S1000D" has no catalog import of its own -- it's the
# SAME 27 BRDP decisions as "BREX — S1000D 3.0.1" (generateBREXSch.js
# generates a real BREX 3.0.1 under the hood and converts it
# deterministically), so its catalog lookup aliases to that standard
# instead of being imported a second time under a different standard
# string (would duplicate the same 27 rows in Postgres for no reason).
# Mirrors the same "these two standards are the same underlying rule set"
# fact that routes/similar.py's _STANDARD_TO_RULE_FORMAT and
# src/constants/ruleFormats.js's STANDARD_TO_RULE_FORMAT already encode
# for rule-approval formats -- not a new, independent decision.
_CATALOG_STANDARD_ALIASES = {
    "Schematron 1.0 — S1000D": "BREX — S1000D 3.0.1",
}


def _resolve_catalog_standard(standard: str) -> str:
    return _CATALOG_STANDARD_ALIASES.get(standard, standard)


@router.get("/count", response_model=BRDPCatalogCountOut)
async def get_catalog_count(
    standard: str,
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BRDPCatalogCountOut:
    catalog_standard = _resolve_catalog_standard(standard)
    count = (
        await db.execute(
            select(func.count()).select_from(BRDPCatalog).where(BRDPCatalog.standard == catalog_standard)
        )
    ).scalar_one()
    # `standard` in the response echoes what was actually requested (e.g.
    # "Schematron 1.0 — S1000D"), not the aliased standard the count came
    # from -- the caller shouldn't need to know about the alias at all.
    return BRDPCatalogCountOut(standard=standard, count=count)


@router.get("", response_model=list[BRDPCatalogEntryOut])
async def list_catalog_entries(
    standard: str,
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[BRDPCatalog]:
    catalog_standard = _resolve_catalog_standard(standard)
    result = await db.execute(
        select(BRDPCatalog).where(BRDPCatalog.standard == catalog_standard).order_by(BRDPCatalog.identifier)
    )
    return list(result.scalars().all())
