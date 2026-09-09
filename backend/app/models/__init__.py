"""ORM models — one module per table (see docs/v2/03-especificacion-v2-para-claude-code.md §2).

Imported here so Alembic's autogenerate (env.py: `target_metadata = Base.metadata`)
sees every table without each caller needing to import every module by hand.
"""

from app.models.brdp import BRDP
from app.models.note import Note
from app.models.project import Project
from app.models.refresh_token import RefreshToken
from app.models.rule_approval import RuleApproval
from app.models.suggestion_feedback import SuggestionFeedback
from app.models.user import User
from app.models.user_project_role import UserProjectRole

__all__ = [
    "BRDP",
    "Note",
    "Project",
    "RefreshToken",
    "RuleApproval",
    "SuggestionFeedback",
    "User",
    "UserProjectRole",
]
