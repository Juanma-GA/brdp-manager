"""One-off cleanup: take legacy wrappers off the rules already stored.

Real cases: BRDP-S1-00507 (<rules> around a structureObjectRule and a
nonContextRule) and BRDP-S1-00070 (a bare <structureObjectRuleGroup> around
two structureObjectRule), S1000D 4.2. Generate never used these wrappers, but
the format check and the rule test reject them; the Excel import now stores
rules clean (app/services/rule_wrappers.py), and this script cleans what was
stored before.

For every stored BREX rule (BRDPs in the trash included) whose format check
reports a wrapper, the rules inside are kept exactly as written, one after
the other, and the wrapper tags go. The rule keeps its Rule Status; the
change is recorded in the BRDP's history (field "Rule", old and new text) in
the name of --user. A wrapper that also holds text or another element is not
touched (that content would be lost) and is listed as "left as is" -- fix
those in the interface. Afterwards scripts/report_invalid_rules.py should
list nothing with a wrapper.

    cd backend && .venv/bin/python scripts/normalize_rule_wrappers.py --dry-run
    cd backend && .venv/bin/python scripts/normalize_rule_wrappers.py [--user admin@example.com]

--user: the account the history entries are recorded under (default: the
oldest user with the global role admin). --dry-run: list what would change,
write nothing.
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.db.base import async_session_factory
from app.models import User
from app.services.rule_wrappers import normalize_stored_rule_wrappers


async def main(dry_run: bool, email: str | None) -> int:
    async with async_session_factory() as session:
        stmt = select(User).where(User.email == email) if email else select(User).where(User.global_role == "admin").order_by(User.created_at)
        user = (await session.execute(stmt)).scalars().first()
        if user is None:
            print(f"No user {email!r}." if email else "No admin user to record the history entries under; pass --user.")
            return 2
        results = await normalize_stored_rule_wrappers(session, user, dry_run=dry_run)
        cleaned = [r for r in results if r["changed"]]
        left = [r for r in results if not r["changed"]]
        verb = "Would clean" if dry_run else "Cleaned"
        print(f"{verb} {len(cleaned)} stored rule(s); {len(left)} with a wrapper left as is. History entries under {user.email}.")
        for r in cleaned:
            print(f"\n== {r['project']} / {r['identifier']} ({r['format']})\n-- before:\n{r['old']}\n-- after:\n{r['new']}")
        for r in left:
            print(f"\n!! left as is (the wrapper holds text or another element): {r['project']} / {r['identifier']} ({r['format']})")
        if not dry_run:
            await session.commit()
    return 0


if __name__ == "__main__":
    # UTF-8 whatever the console code page: the Node verify scripts read this
    # output as UTF-8, and rule text / project names can be any character
    # (on Windows stdout is cp1252 by default).
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list what would change, write nothing")
    parser.add_argument("--user", help="email of the account the history entries are recorded under")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.dry_run, args.user)))
