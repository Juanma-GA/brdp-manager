import uuid

from pydantic import BaseModel, EmailStr, field_validator

from app.core.security import MIN_PASSWORD_LENGTH


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
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

    model_config = {"from_attributes": True}


class MeUpdate(BaseModel):
    # email and global_role are deliberately absent -- a user editing their
    # own profile must never be able to touch either, especially not
    # global_role (self-granting admin). Only display_name is editable here.
    display_name: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
    # The caller's OWN current refresh token, if it has one stored -- lets
    # the endpoint exclude that one session from the "revoke every other
    # refresh token" step below (docs request: "no el de la sesión
    # actual"). Optional so a caller with nothing stored still works, it
    # just revokes everything in that case.
    current_refresh_token: str | None = None

    @field_validator("new_password")
    @classmethod
    def _enforce_min_length(cls, value: str) -> str:
        if len(value) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
        return value
