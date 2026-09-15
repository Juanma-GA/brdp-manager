from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.base import get_db
from app.models import AppSettings, User
from app.models.app_settings import SINGLETON_ID
from app.schemas.app_settings import AppSettingsOut, AppSettingsUpdate

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.global_role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return current_user


async def _get_singleton(db: AsyncSession) -> AppSettings:
    settings = await db.get(AppSettings, SINGLETON_ID)
    if settings is None:
        # Can only happen against a database that's behind migration 0009
        # (which is the only place this row is ever inserted) -- a real
        # deployment problem, not a normal runtime path to design around.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="App settings not initialized -- run `alembic upgrade head`.",
        )
    return settings


@router.get("/import-eta", response_model=AppSettingsOut)
async def get_import_eta_settings(
    _current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> AppSettings:
    """Any authenticated user, not admin-only -- an editor performing an
    Apply import needs these 4 numbers to compute their own accurate ETA
    (see ProjectConfigPage.jsx's DataManagementSection), same as how
    GET /api/config/ai-provider is readable by everyone even though only
    an admin edits the underlying value. What's admin-only is the ability
    to CHANGE this (see PUT below) and the Settings page section that
    exposes it as an editable admin control -- not the numbers themselves
    being used, invisibly, wherever an ETA is computed.
    """
    return await _get_singleton(db)


@router.put("/import-eta", response_model=AppSettingsOut)
async def update_import_eta_settings(
    body: AppSettingsUpdate,
    admin: User = Depends(_require_admin),
    db: AsyncSession = Depends(get_db),
) -> AppSettings:
    settings = await _get_singleton(db)
    settings.apply_eta_ms_per_plain_row = body.apply_eta_ms_per_plain_row
    settings.apply_eta_ms_per_validated_row = body.apply_eta_ms_per_validated_row
    settings.apply_eta_validated_rows_threshold = body.apply_eta_validated_rows_threshold
    settings.apply_eta_warning_seconds = body.apply_eta_warning_seconds
    settings.updated_by = admin.id
    await db.commit()
    await db.refresh(settings)
    return settings
