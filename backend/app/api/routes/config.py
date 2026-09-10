from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.models import User

router = APIRouter(prefix="/api/config", tags=["config"])


class AIProviderOut(BaseModel):
    provider: str  # "mistral" | "qwen"
    # The frontend still builds the request payload itself (llmAPI.js's
    # buildRequestBody -- prompt construction is NOT this backend's job,
    # docs/v2 §4), so it needs a real model name for the payload's "model"
    # field even though the API key/endpoint are now fully server-side.
    model: str


@router.get("/ai-provider", response_model=AIProviderOut)
async def get_ai_provider(_current_user: User = Depends(get_current_user)) -> AIProviderOut:
    """Read-only (docs/v2 §5): AI Configuration in Settings shows this, it
    never lets the user edit it -- the active provider is a server .env
    decision, not a per-user preference.
    """
    settings = get_settings()
    model = settings.mistral_model if settings.active_llm_provider == "mistral" else settings.qwen_chat_model
    return AIProviderOut(provider=settings.active_llm_provider, model=model)
