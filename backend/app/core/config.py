from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[3]

# Excel's hard limit on the text of one cell (a fact of the file format, not
# a setting): app/services/excel_io.py refuses an export over it, and it is
# the default limit for every long BRDP text below, so whatever is saved can
# always be exported.
EXCEL_CELL_CHAR_LIMIT = 32767


class Settings(BaseSettings):
    """Backend configuration, all overridable via environment variables or a
    .env file in backend/. Every setting used by the app lives here — no
    values hardcoded elsewhere (docs/v2/02-analisis-aacf-requisitos-no-cumplidos.md
    D3/D4).
    """

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Environment ---
    # Only "production" flips the refresh-token cookie's Secure flag on
    # (see api/routes/auth.py) -- a Secure cookie is dropped by the browser
    # over plain HTTP, which is what local dev serves over.
    environment: str = "development"

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
    # MISTRAL_MODEL, not hardcoded: this deployment's private Mistral
    # endpoint may not accept the same model names as the public API, so
    # this has to be changeable from .env without a code change if
    # "mistral-medium-latest" turns out not to be right for it either.
    mistral_model: str = "mistral-medium-latest"
    mistral_embed_endpoint: str = "https://api.mistral.ai/v1/embeddings"
    mistral_embed_model: str = "mistral-embed"
    qwen_api_key: str | None = None
    qwen_endpoint: str | None = None
    qwen_chat_model: str = "qwen-plus"

    # --- CORS (Phase 3) ---
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:80"]

    # --- BREX XSD validation (Phase 3) ---
    # v1's real reference schemas (server.js's BREX_XSD_MAP) -- gitignored in
    # the repo root (large reference material provisioned separately), not
    # something this backend ships copies of.
    sources_dir: str = str(_REPO_ROOT / "sources")

    # --- Excel import (app/services/excel_io.py) ---
    # Defensive limits on an uploaded workbook; a file over any of them is
    # refused with a 422 naming the limit, nothing imported. Generous for
    # real projects (SOPTE, the largest, is ~2,800 BRDPs in well under 2 MB).
    excel_import_max_bytes: int = 10 * 1024 * 1024
    excel_import_max_uncompressed_bytes: int = 200 * 1024 * 1024
    excel_import_max_rows: int = 20000

    # --- AI Extract (app/services/rule_extract.py) ---
    # Largest BREX/Schematron accepted; over it, a 413 with the reason. The
    # "CA" BREX (5,536 rules, the largest seen) is 2.8 MB.
    rule_extract_max_bytes: int = 20 * 1024 * 1024
    # AI Extract (2/2), free text: at most this many words (every proposed
    # BRDP is reviewed by a person; a long text gives too many). Characters
    # are capped too, so a text with few but huge "words" is still bounded.
    extract_text_max_words: int = 5000
    extract_text_max_chars: int = 200_000
    # A decision's literal quote kept from a free text (stored whole, never
    # cut): over it the candidate is refused with a warning. The limit the
    # decisions request already had (schemas/rule_extract.py).
    extract_quote_max_chars: int = 20000

    # --- BRDP text limits (AACF 1, Part 5) ---
    # Checked on create/edit (schemas/brdp.py) and before an AI Extract
    # import; over a limit the request is refused with the limit, never cut
    # (HR6/HR7). Title: the limit AI Extract already used for a title.
    # Definition, Proposal and the refusal reason: Excel's cell limit, so
    # every saved BRDP can be exported.
    brdp_title_max_chars: int = 2000
    brdp_text_max_chars: int = EXCEL_CELL_CHAR_LIMIT

    # --- Project name (Duplicar un proyecto) ---
    # One limit for creating, renaming, restoring and duplicating a project:
    # the name is trimmed and must be 1..N characters; over it, 422 with the
    # limit, never cut.
    project_name_max_chars: int = 200

    # --- LLM proxy limits (AACF 1, Part 5) ---
    # The largest max_tokens the app asks for (the rule test's examples,
    # src/prompts/shared.js RULE_TEST_MAX_TOKENS); a request over it is
    # refused, never lowered silently.
    llm_max_tokens: int = 16000
    # Longest wait for the provider on a chat call, in seconds: until the
    # first byte of the answer and between two bytes of it. Over it the
    # call ends with a 504 (llm_timeout) and its llm_calls row is "failed".
    # 0 = no limit. Embeddings are not affected.
    llm_request_timeout_seconds: int = 300

    # --- LLM call limits per user (Protecciones 2a, AACF G12) ---
    # Chat calls through /api/llm-proxy (embeddings are not limited), per
    # user, counted from llm_calls over a moving window (the last 60 s, the
    # last 24 h), so they hold across processes and browser tabs. 0 = no
    # limit. Over a limit the call is refused with a 429 (llm_rate_limited)
    # and the provider is not called.
    # Defaults sized from the app's own peak rate: AI Extract writes texts
    # in 3 parallel batches, the fastest real use (~3 s per answer) being
    # ~60 calls/minute; a full prompt-eval run with --runs 3 is ~900 calls
    # in a day. 120/minute and 3000/day leave twice that, and more.
    llm_calls_per_minute: int = 120
    llm_calls_per_day: int = 3000

    # --- Interface preferences (AACF 3, Part 1) ---
    # users.ui_preferences.records_detail_width: the Records detail panel's
    # width in px. The minimum is the divider's own (src/pages/RecordsPage.jsx
    # DETAIL_PANEL_MIN_WIDTH); the maximum only rules out absurd values --
    # the page clips a width that does not fit the window when it shows it.
    ui_detail_width_min: int = 360
    ui_detail_width_max: int = 4000


@lru_cache
def get_settings() -> Settings:
    return Settings()
