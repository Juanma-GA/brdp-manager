"""One-off bootstrap: create the first admin user (docs/v2/03-especificacion-v2-para-claude-code.md
§9). There is no public registration endpoint and nothing seeds an admin in
the Alembic migration on purpose -- run this once per environment:

    cd backend && python scripts/create_admin_user.py

Reads INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD from the environment
(backend/.env) if set; otherwise prompts interactively. Refuses to modify an
existing user rather than silently changing its role or password.
"""
import asyncio
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import hash_password
from app.db.base import async_session_factory
from app.models import User


async def main() -> None:
    settings = get_settings()
    email = settings.initial_admin_email or input("Admin email: ").strip()

    password = settings.initial_admin_password
    if not password:
        password = getpass.getpass("Admin password: ")
        if password != getpass.getpass("Confirm password: "):
            print("Passwords did not match.", file=sys.stderr)
            sys.exit(1)

    if not email or not password:
        print("Email and password are both required.", file=sys.stderr)
        sys.exit(1)

    async with async_session_factory() as session:
        existing = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if existing is not None:
            print(
                f"A user with email {email} already exists "
                f"(id={existing.id}, global_role={existing.global_role}). "
                "Refusing to modify it.",
                file=sys.stderr,
            )
            sys.exit(1)

        user = User(
            email=email,
            password_hash=hash_password(password),
            display_name="Admin",
            global_role="admin",
        )
        session.add(user)
        await session.commit()
        print(f"Created admin user {email} (id={user.id}).")


if __name__ == "__main__":
    asyncio.run(main())
