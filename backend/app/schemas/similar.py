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
    # kind='definition' (docs request -- Suggest Definition corpus with
    # catalog): the candidate's Title, needed alongside `text` (Definition)
    # to build the "Title: … / Definition: …" reference block.
    # kind='proposal' (docs request, Suggest Proposal round): also
    # populated, for the UI's "título recortado" reference-row display --
    # never used in the prompt itself for this kind (the prompt's three
    # blocks cite identifier/project/score, never the title). Empty for
    # kind='rule'.
    title: str = ""
    # kind='definition' (docs request -- readable references round): the
    # candidate's Definition, under its own name so the frontend's
    # expandable reference row has a clean field to render instead of
    # reaching for `text` (a generic per-kind payload -- proposal text or
    # rule_xml for the other kinds -- not something a reference-list UI
    # should read semantics into).
    # kind='proposal' (docs request, Suggest Proposal round): ALSO
    # populated for every candidate in all three groups, including "Same
    # BRDP in other projects" (whose PROMPT block never cites Definition --
    # only Proposal -- but the UI still expands both on click, per the
    # docs request: "despliega su Definition y su Proposal"). `text` stays
    # the candidate's Proposal for this kind, unchanged from before.
    # Empty for kind='rule'.
    definition: str = ""
    # kind='definition': human-readable precedent origin, since this kind's
    # candidate pool spans BOTH this standard's other projects (Records)
    # and its official catalog (Catalog) and the UI/prompt must say which
    # -- "Records: <project name>" or "Catalog".
    # kind='proposal' (docs request, Suggest Proposal round): reused for
    # the BARE project name (never "Records: "-prefixed, no catalog exists
    # for this kind at all) -- the exact `{project name}` token the
    # "Same BRDP in other projects"/"Similar decisions" prompt blocks need.
    # Empty for the "This project" group (the project is implied, never
    # named in that block) and for kind='rule'.
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
    # catalog.
    # kind='proposal' (docs request, Suggest Proposal round): the "Similar
    # decisions" group -- up to 5 Validated BRDPs (non-empty Proposal) in
    # OTHER projects meeting MIN_SIMILARITY, any identifier prefix. When
    # `same_brdp` below is non-empty, this group only tops it up to a
    # COMBINED total of 5 (5 - len(same_brdp) here) -- when `same_brdp` is
    # empty (no matching catalog identifier), this alone provides all 5.
    # kind='rule': unchanged, up to CANDIDATE_LIMIT from this project's own
    # standard-wide search.
    candidates: list[SimilarCandidateOut]
    # kind='definition' only: up to 3 "different in content, same style"
    # references (the 3 candidates with the LOWEST similarity in the whole
    # corpus), added ONLY when `candidates` above has fewer than 3 entries
    # -- never for proposal/rule (always empty there).
    style_references: list[SimilarCandidateOut] = []
    # kind='proposal' only (docs request, Suggest Proposal round): the
    # "Same BRDP in other projects" group -- up to 5 Validated BRDPs
    # (non-empty Proposal) in OTHER projects sharing this BRDP's EXACT
    # identifier, found by a direct identifier lookup (never embeddings).
    # Only populated when this identifier exists in this standard's
    # official catalog (`brdp_catalog`) -- an EXT-style auto-generated
    # identifier can coincidentally match across two unrelated projects,
    # so identifier matching is only semantically meaningful for a real
    # catalog-issued id. Always empty for definition/rule.
    same_brdp: list[SimilarCandidateOut] = []
    # kind='proposal' only (docs request, Suggest Proposal round): the
    # "This project" group -- up to 3 Validated BRDPs (non-empty Proposal)
    # in THIS SAME project meeting MIN_SIMILARITY. Disjoint from
    # `same_brdp`/`candidates` above by construction (those are always
    # OTHER projects), so never needs cross-group dedup against them.
    # Always empty for definition/rule.
    this_project: list[SimilarCandidateOut] = []
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
