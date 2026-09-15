import hashlib
import secrets
import string
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

# Comfortably above MIN_PASSWORD_LENGTH (docs request: "mínimo 12
# caracteres") -- one fixed length, not a random range, since there's no
# reason for it to vary and a fixed value is simpler to reason about.
TEMPORARY_PASSWORD_LENGTH = 16

# Alphanumeric + a handful of symbols -- avoids characters that are easy to
# mis-transcribe when an admin reads a temporary password aloud or pastes
# it somewhere (no ambiguous-looking set here, just a broad-enough
# character pool that `secrets.choice` picking uniformly from it gives a
# real, high-entropy result at TEMPORARY_PASSWORD_LENGTH).
_TEMPORARY_PASSWORD_ALPHABET = string.ascii_letters + string.digits + "!@#$%^&*"


def generate_temporary_password() -> str:
    """A real random one-time password (docs request: NOT a fixed value
    like "1234" -- that would be a known, shared credential exploitable by
    anyone with app access, and would violate MIN_PASSWORD_LENGTH besides).
    Uses `secrets`, not `random` -- this is for authentication, it has to
    be cryptographically secure, not just look random. Callers (create_user,
    reset_password) never persist this in plaintext anywhere; it's handed
    back in the response body exactly once.
    """
    return "".join(secrets.choice(_TEMPORARY_PASSWORD_ALPHABET) for _ in range(TEMPORARY_PASSWORD_LENGTH))


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
