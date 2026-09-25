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
    # kind='definition' only (docs request -- Suggest Definition corpus
    # with catalog): the candidate's Title, needed alongside `text`
    # (Definition) to build the "Title: … / Definition: …" reference block
    # the frontend's buildSuggestDefinitionPrompt() renders. Empty for
    # proposal/rule -- their prompt never needed the title.
    title: str = ""
    # kind='definition' only: human-readable precedent origin, since this
    # kind's candidate pool spans BOTH this standard's other projects
    # (Records) and its official catalog (Catalog) and the UI/prompt must
    # say which -- "Records — <project name>" or "Catalog". Empty for
    # proposal/rule, whose candidates are never labeled by origin.
    source: str = ""


class SimilarOut(BaseModel):
    kind: str
    # docs/v2 §3 point 3 (HR7: never silently degrade) -- false whenever
    # fewer than MIN_CANDIDATES passed the similarity threshold. The
    # frontend must surface `message` explicitly in that case rather than
    # quietly building a few-shot prompt from weak/unrelated precedent.
    # kind='definition' (docs request): MIN_CANDIDATES no longer applies
    # -- this is always True and `message` is always None for that kind,
    # since the LLM is now always called regardless of precedent count.
    sufficient_precedent: bool
    # kind='definition': the "Similar" list -- up to 5 candidates meeting
    # MIN_SIMILARITY, across this standard's other projects AND its
    # catalog. kind='proposal'/'rule': unchanged, up to CANDIDATE_LIMIT
    # from this project's own standard-wide search.
    candidates: list[SimilarCandidateOut]
    # kind='definition' only: up to 3 "different in content, same style"
    # references (the 3 candidates with the LOWEST similarity in the whole
    # corpus), added ONLY when `candidates` above has fewer than 3 entries
    # -- never for proposal/rule (always empty there).
    style_references: list[SimilarCandidateOut] = []
    message: str | None = None
    # kind='rule' only: the rule_approvals format these candidates' rule_xml
    # came from, so a frontend that accepts a suggested rule knows which
    # format to PUT it to as a new pending_review approval, without having
    # to duplicate routes/similar.py's standard->format mapping itself.
    format: str | None = None
    # Docs request (on-demand embeddings, HR7 -- never silently degrade):
    # a Validated BRDP in another project of the same standard, with no
    # embedding yet, is invisible to this precedent search -- computing it
    # is scoped to ITS OWN project's editors launching a job there, not to
    # whichever project happens to call /similar. Rather than let that
    # exclusion be silent, this counts how many were left out for exactly
    # that reason, so the frontend can say so explicitly. Always 0 when
    # every other project's Validated BRDPs of this standard are already
    # embedded (the common case once each project has run its job once).
    excluded_pending_other_projects: int = 0
