"""Shared by ProjectOut (GET /api/projects, one project row's own counts)
and BRDPStatsOut (GET /api/projects/{id}/brdps/stats, a single project's
counts) -- both need the exact same two shapes, computed by
app/repositories/brdp_repository.py's compute_status_counts(). Kept in its
own module rather than defined in either schemas/project.py or
schemas/brdp.py to avoid a cross-import between the two for what is really
a third, independent concept (a status distribution over a set of BRDPs).
"""
from pydantic import BaseModel


class ProposalStatusCounts(BaseModel):
    """brdps.validation counts -- "Pending" | "Validated" | "Refused"."""

    pending: int = 0
    validated: int = 0
    refused: int = 0


class RuleStatusCounts(BaseModel):
    """Rule Status counts, scoped to the project's OWN rule_approvals
    format (STANDARD_TO_RULE_FORMAT[project.standard], None for S1000D
    5.0/6.0 -- see compute_status_counts()'s docstring for why that
    scoping matters). to_do is the absence of an approval row (or, for a
    standard with no rule format at all, every active BRDP).
    """

    to_do: int = 0
    draft: int = 0
    verified: int = 0
