"""ORM models — one module per table (see docs/v2/03-especificacion-v2-para-claude-code.md §2).

Imported here so Alembic's autogenerate (env.py: `target_metadata = Base.metadata`)
sees every table without each caller needing to import every module by hand.
"""

from app.models.audit_log import AuditLog
from app.models.brdp import BRDP
from app.models.brdp_catalog import BRDPCatalog
from app.models.brdp_history import BRDPHistory
from app.models.embedding_job import EmbeddingJob
from app.models.import_job import ImportJob
from app.models.llm_call import LlmCall
from app.models.project import Project
from app.models.refresh_token import RefreshToken
from app.models.rule_approval import RuleApproval
from app.models.rule_extract_job import RuleExtractCandidate, RuleExtractJob
from app.models.suggestion_feedback import SuggestionFeedback
from app.models.user import User
from app.models.user_project_role import UserProjectRole

__all__ = [
    "AuditLog",
    "BRDP",
    "BRDPCatalog",
    "BRDPHistory",
    "EmbeddingJob",
    "ImportJob",
    "LlmCall",
    "Project",
    "RefreshToken",
    "RuleApproval",
    "RuleExtractCandidate",
    "RuleExtractJob",
    "SuggestionFeedback",
    "User",
    "UserProjectRole",
]
