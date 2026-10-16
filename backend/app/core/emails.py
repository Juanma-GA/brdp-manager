"""One email check for the whole backend.

Login (LoginRequest), Create user and Edit user (UserCreate/UserUpdate) all
take ``EmailStr``: pydantic's email-validator, which rejects special-use
domains (``.local``, ``.localhost``, ``.test``, ``.invalid``, ``.example``…)
and normalises the domain to lower case. A script that writes a user
directly (create_admin_user.py) must use this same check, or it can create
an account whose email the login form refuses -- or one stored with an
upper-case domain that the login (which looks up the normalised email)
never finds.
"""
from pydantic import EmailStr, TypeAdapter, ValidationError

_EMAIL = TypeAdapter(EmailStr)


class InvalidEmail(ValueError):
    """The email is one the login would refuse; str() says why."""


def normalize_email(raw: str) -> str:
    """The email exactly as the login validates and looks it up, or
    InvalidEmail with the validator's own reason."""
    try:
        return _EMAIL.validate_python((raw or "").strip())
    except ValidationError as exc:
        reason = exc.errors()[0].get("msg", "invalid email")
        prefix = "value is not a valid email address: "
        if reason.startswith(prefix):
            reason = reason[len(prefix):]
        raise InvalidEmail(reason) from None
