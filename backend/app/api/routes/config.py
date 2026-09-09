from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.models import User

router = APIRouter(prefix="/api/config", tags=["config"])


class AIProviderOut(BaseModel):
    provider: str  # "mistral" | "qwen"


@router.get("/ai-provider", response_model=AIProviderOut)
async def get_ai_provider(_current_user: User = Depends(get_current_user)) -> AIProviderOut:
    """Read-only (docs/v2 §5): AI Configuration in Settings shows this, it
    never lets the user edit it -- the active provider is a server .env
    decision, not a per-user preference.
    """
    return AIProviderOut(provider=get_settings().active_llm_provider)
