import uuid

from pydantic import BaseModel, EmailStr


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

    model_config = {"from_attributes": True}


class MeUpdate(BaseModel):
    # email and global_role are deliberately absent -- a user editing their
    # own profile must never be able to touch either, especially not
    # global_role (self-granting admin). Only display_name is editable here.
    display_name: str
