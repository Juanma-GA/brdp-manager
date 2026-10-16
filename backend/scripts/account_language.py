"""The interface language saved on an account (users.preferred_language),
read or set -- for the browser scripts (scripts/lib/seeds.mjs
keepAccountLanguage): a verify-*.mjs that switches the account to Spanish
gives it back the language it had when it exits, so the next script does not
run in Spanish (Regresión antes del despliegue).

    cd backend && python scripts/account_language.py <email>            # prints it ("" = none)
    cd backend && python scripts/account_language.py <email> <lang|"">  # sets it
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.db.base import async_session_factory
from app.models import User


async def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    email = sys.argv[1].lower()
    async with async_session_factory() as db:
        user = (await db.execute(select(User).where(User.email == email, User.deleted_at.is_(None)))).scalar_one_or_none()
        if user is None:
            print(f"no active user {email}", file=sys.stderr)
            sys.exit(1)
        if len(sys.argv) > 2:
            user.preferred_language = sys.argv[2] or None
            await db.commit()
        else:
            print(user.preferred_language or "")


if __name__ == "__main__":
    asyncio.run(main())
