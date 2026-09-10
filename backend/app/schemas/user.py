import uuid

from pydantic import BaseModel, EmailStr

from app.schemas.auth import UserOut


class UserCreate(BaseModel):
    email: EmailStr
    password: str
    display_name: str
    global_role: str = "user"  # "user" | "admin"


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
