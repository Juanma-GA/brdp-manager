import uuid

from pydantic import BaseModel, EmailStr, field_validator

from app.core.security import MIN_PASSWORD_LENGTH


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    global_role: str
    # The frontend's own signal (docs request) to force the Change
    # Password screen right after login, before anything else is
    # reachable -- true right after Create user or an admin's Reset
    # password, cleared back to False by a successful change-password.
    must_change_password: bool
    # NULL = no preference chosen yet -- AuthContext falls back to the
    # frontend's existing 'en' default in that case, same as before this
    # field existed (docs request's own explicit edge case for accounts
    # that predate this column, or that just haven't touched the
    # language switcher).
    preferred_language: str | None = None
    # Docs request (naming-convention tip round): "Don't show again" on the
    # naming-tip banner, persisted server-side per account. Plain boolean,
    # never None -- every account either has it hidden or doesn't.
    hide_naming_tip: bool = False

    model_config = {"from_attributes": True}


_SUPPORTED_LANGUAGES = {"en", "es"}


class MeUpdate(BaseModel):
    # email and global_role are deliberately absent -- a user editing their
    # own profile must never be able to touch either, especially not
    # global_role (self-granting admin).
    #
    # Both fields optional + exclude_unset (see update_me in
    # api/routes/auth.py) so LanguageSwitcher can PATCH just
    # preferred_language without also having to resend the current
    # display_name -- same partial-update convention as BRDPUpdate.
    display_name: str | None = None
    preferred_language: str | None = None
    # Settings > Profile's "Show naming tips again" sends {hide_naming_tip:
    # false}; the naming-tip banner's own "Don't show again" sends {true}.
    hide_naming_tip: bool | None = None

    @field_validator("preferred_language")
    @classmethod
    def _validate_language(cls, value: str | None) -> str | None:
        if value is not None and value not in _SUPPORTED_LANGUAGES:
            raise ValueError(f"Unsupported language: {value!r}")
        return value


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _enforce_min_length(cls, value: str) -> str:
        if len(value) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
        return value
