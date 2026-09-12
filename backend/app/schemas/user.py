import uuid

from pydantic import BaseModel, EmailStr

from app.schemas.auth import UserOut


class UserCreate(BaseModel):
    # No password field at all (docs request: unify with the admin Reset
    # password flow) -- create_user always generates a real random
    # temporary password server-side via generate_temporary_password(),
    # never one the admin types in. Structurally impossible to set a
    # known/fixed initial password through this endpoint, same pattern
    # this codebase already uses to make a field un-settable (see
    # BRDPUpdate leaving out identifier).
    email: EmailStr
    display_name: str
    global_role: str = "user"  # "user" | "admin"


class TemporaryPasswordOut(BaseModel):
    """Response shape for both create_user and reset_password -- the raw
    temporary password is included exactly once, here, in this one
    response. Never stored in plaintext anywhere, never logged, never
    retrievable again after this.
    """

    temporary_password: str


class UserCreateOut(UserOut, TemporaryPasswordOut):
    pass


class UserUpdate(BaseModel):
    # global_role is deliberately absent -- only assignable at creation
    # (this round's spec), never editable afterward through this endpoint.
    email: EmailStr
    display_name: str


class ProjectRoleAssign(BaseModel):
    project_id: uuid.UUID
    role: str  # "viewer" | "editor"


class ProjectRoleOut(BaseModel):
    project_id: uuid.UUID
    role: str

    model_config = {"from_attributes": True}


class UserWithRolesOut(UserOut):
    project_roles: list[ProjectRoleOut] = []
