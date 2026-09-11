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


@router.get("/count", response_model=BRDPCatalogCountOut)
async def get_catalog_count(
    standard: str,
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BRDPCatalogCountOut:
    count = (
        await db.execute(select(func.count()).select_from(BRDPCatalog).where(BRDPCatalog.standard == standard))
    ).scalar_one()
    return BRDPCatalogCountOut(standard=standard, count=count)


@router.get("", response_model=list[BRDPCatalogEntryOut])
async def list_catalog_entries(
    standard: str,
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[BRDPCatalog]:
    result = await db.execute(
        select(BRDPCatalog).where(BRDPCatalog.standard == standard).order_by(BRDPCatalog.identifier)
    )
    return list(result.scalars().all())
