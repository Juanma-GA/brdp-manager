from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Backend configuration, all overridable via environment variables or a
    .env file in backend/. Every setting used by the app lives here — no
    values hardcoded elsewhere (docs/v2/02-analisis-aacf-requisitos-no-cumplidos.md
    D3/D4).
    """

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Database (Phase 1) ---
    database_url: str = "postgresql+asyncpg://brdp:brdp@localhost:5432/brdp_manager"

    # --- Auth (Phase 2) ---
    jwt_private_key_path: str = "keys/jwt_private.pem"
    jwt_public_key_path: str = "keys/jwt_public.pem"
    access_token_expire_minutes: int = 45
    refresh_token_expire_days: int = 14
    initial_admin_email: str | None = None
    initial_admin_password: str | None = None

    # --- LLM proxy (Phase 3) ---
    # Only ONE of these is active per deployment (see docs/v2 §3 point 6 —
    # data-residency rationale for keeping Mistral/Qwen as separate,
    # mutually-exclusive endpoints instead of one client-selectable one).
    active_llm_provider: str = "mistral"  # "mistral" | "qwen"
    mistral_api_key: str | None = None
    mistral_endpoint: str = "https://api.mistral.ai/v1/chat/completions"
    mistral_embed_endpoint: str = "https://api.mistral.ai/v1/embeddings"
    mistral_embed_model: str = "mistral-embed"
    qwen_api_key: str | None = None
    qwen_endpoint: str | None = None

    # --- CORS (Phase 3) ---
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:80"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
