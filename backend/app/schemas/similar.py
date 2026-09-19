import uuid

from pydantic import BaseModel


class SimilarCandidateOut(BaseModel):
    id: uuid.UUID
    identifier: str
    # definition, proposal, or rule_xml, depending on the request's `kind`.
    text: str
    # Cosine similarity (1 - pgvector's cosine distance), 1.0 = identical,
    # higher is more similar -- intentionally the inverse of the raw
    # distance pgvector's `<=>` returns, since "higher is better" is the
    # intuitive direction for a frontend to sort/display on.
    score: float


class SimilarOut(BaseModel):
    kind: str
    # docs/v2 §3 point 3 (HR7: never silently degrade) -- false whenever
    # fewer than MIN_CANDIDATES passed the similarity threshold. The
    # frontend must surface `message` explicitly in that case rather than
    # quietly building a few-shot prompt from weak/unrelated precedent.
    sufficient_precedent: bool
    candidates: list[SimilarCandidateOut]
    message: str | None = None
    # kind='rule' only: the rule_approvals format these candidates' rule_xml
    # came from, so a frontend that accepts a suggested rule knows which
    # format to PUT it to as a new pending_review approval, without having
    # to duplicate routes/similar.py's standard->format mapping itself.
    format: str | None = None
