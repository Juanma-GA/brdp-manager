"""One-off dev-only bootstrap: creates a demo project plus one editor and one
viewer user assigned to it, so Phase 4's real-browser verification (and
anyone else's local testing) has real accounts to log in as without hand
crafting SQL. Mirrors create_admin_user.py's idempotency: refuses to touch
an email that already exists rather than silently resetting its password.

    cd backend && python scripts/seed_dev_data.py

Not meant for production -- passwords are fixed and printed to stdout.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.core.security import hash_password
from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole

DEMO_PROJECT_NAME = "Demo Project (S1000D 4.2)"
DEMO_USERS = [
    ("editor_a@example.com", "Editor A", "editor", "EditorA-Pass123!"),
    ("viewer_a@example.com", "Viewer A", "viewer", "ViewerA-Pass123!"),
]


async def main() -> None:
    async with async_session_factory() as session:
        project = (
            await session.execute(select(Project).where(Project.name == DEMO_PROJECT_NAME))
        ).scalar_one_or_none()
        if project is None:
            project = Project(
                name=DEMO_PROJECT_NAME,
                standard="BREX — S1000D 4.2",
                project_config={
                    "modelIdentCode": "DMOD",
                    "systemDiffCode": "A",
                    "issueNumber": "001",
                    "languageIsoCode": "en",
                    "countryIsoCode": "US",
                    "securityClassification": "01",
                },
            )
            session.add(project)
            await session.commit()
            await session.refresh(project)
            print(f"Created project {DEMO_PROJECT_NAME!r} (id={project.id}).")
        else:
            print(f"Project {DEMO_PROJECT_NAME!r} already exists (id={project.id}), reusing it.")

        for email, display_name, role, password in DEMO_USERS:
            user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
            if user is not None:
                print(f"User {email} already exists (id={user.id}), leaving it untouched.")
            else:
                user = User(
                    email=email,
                    password_hash=hash_password(password),
                    display_name=display_name,
                    global_role="user",
                )
                session.add(user)
                await session.commit()
                await session.refresh(user)
                print(f"Created user {email} (id={user.id}) -- password: {password}")

            existing_role = (
                await session.execute(
                    select(UserProjectRole).where(
                        UserProjectRole.user_id == user.id, UserProjectRole.project_id == project.id
                    )
                )
            ).scalar_one_or_none()
            if existing_role is None:
                session.add(UserProjectRole(user_id=user.id, project_id=project.id, role=role))
                await session.commit()
                print(f"Assigned {email} as {role} on {DEMO_PROJECT_NAME!r}.")
            else:
                print(f"{email} is already {existing_role.role} on {DEMO_PROJECT_NAME!r}.")


if __name__ == "__main__":
    asyncio.run(main())
