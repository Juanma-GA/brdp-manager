import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import bcrypt
import jwt

from app.core.config import get_settings

JWT_ALGORITHM = "RS256"

# bcrypt's own hard limit -- passwords past this are truncated by the
# algorithm itself, meaning two different long passwords sharing this
# prefix would hash identically. Rejected explicitly here instead of
# silently truncating.
_BCRYPT_MAX_PASSWORD_BYTES = 72

# The app's first-ever password policy (docs request: none existed before
# this) -- deliberately just a minimum length, no other complexity rule.
# One constant, imported everywhere this needs checking (currently only
# schemas/auth.py's ChangePasswordRequest) instead of the number being
# repeated inline.
MIN_PASSWORD_LENGTH = 8


def hash_password(password: str) -> str:
    encoded = password.encode("utf-8")
    if len(encoded) > _BCRYPT_MAX_PASSWORD_BYTES:
        raise ValueError(f"Password must be at most {_BCRYPT_MAX_PASSWORD_BYTES} bytes")
    return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    encoded = password.encode("utf-8")
    if len(encoded) > _BCRYPT_MAX_PASSWORD_BYTES:
        return False
    return bcrypt.checkpw(encoded, password_hash.encode("ascii"))


@lru_cache
def _private_key() -> str:
    return Path(get_settings().jwt_private_key_path).read_text()


@lru_cache
def _public_key() -> str:
    return Path(get_settings().jwt_public_key_path).read_text()


def create_access_token(user_id: uuid.UUID, expires_delta: timedelta | None = None) -> str:
    """RS256-signed access token. `sub` is the only claim the app trusts for
    identity -- verifying the signature against the public key is
    structurally identical to validating a Keycloak token via JWKS later
    (docs/v2/03-especificacion-v2-para-claude-code.md §4.1); only where the
    public key comes from would change.
    """
    settings = get_settings()
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=settings.access_token_expire_minutes))
    payload = {"sub": str(user_id), "type": "access", "iat": now, "exp": expire}
    return jwt.encode(payload, _private_key(), algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Raises jwt.PyJWTError (or a subclass) on any invalid token -- expired,
    wrong signature, malformed. Callers (api/deps.py) never distinguish the
    reason to the client, only that it was rejected.
    """
    return jwt.decode(token, _public_key(), algorithms=[JWT_ALGORITHM])


def generate_refresh_token() -> tuple[str, str]:
    """Returns (raw_token, token_hash). The raw token is handed to the
    client and never stored; only its hash is persisted (refresh_tokens.token_hash),
    so a database read alone can't be replayed as a valid token. High-entropy
    random string, not a JWT -- refresh tokens are looked up and revoked by
    hash in the DB, they don't need to be self-describing or independently
    verifiable.
    """
    raw = secrets.token_urlsafe(64)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()
