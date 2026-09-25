"""Real calls to Mistral's embeddings endpoint (docs/v2 §3 point 1/6) --
used both by the embedding_jobs background job (routes/embedding_jobs.py,
stored on the row) and at query time for the /similar endpoint's
source-BRDP embedding (routes/similar.py, computed on the fly, never
stored). Same "backend resolves endpoint/key from its own settings,
never from the caller" pattern as routes/llm_proxy.py's
_resolve_provider(); this is a distinct function rather than a generic
"call any Mistral endpoint" helper because the request/response shape
(an "input" list, a "data[].embedding"/"index" array) is specific to
embeddings, not chat completions.

Docs request (batch embeddings): compute_embeddings_batch() sends several
texts in a single request's "input" list instead of one call per text --
confirmed real, ~3s/item measured by the user with the real provider made
a several-thousand-row project's "Compute embeddings" job take hours for
work that should take minutes. Batch-size chunking policy (how many texts
per request) lives with the caller (embedding_jobs.py), not here --
compute_embeddings_batch always sends exactly the list it's given in one
request; it never re-chunks internally.
"""

import asyncio
import hashlib
import logging
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Protocol

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)


class _HasBRDPText(Protocol):
    title: str
    definition: str
    proposal: str


class _HasCatalogText(Protocol):
    title: str
    definition: str


def brdp_embedding_text(brdp: _HasBRDPText) -> str:
    """Composition for a BRDP's embedding (docs request): title+definition+
    proposal. Used both to compute what actually gets stored
    (embedding_jobs.py) and to build the query embedding at /similar time
    (routes/similar.py) -- the two MUST share this exact composition, or a
    query embedded under one text shape would be compared against vectors
    embedded under another.
    """
    return f"{brdp.title}\n\n{brdp.definition}\n\n{brdp.proposal}"


def catalog_embedding_text(entry: _HasCatalogText) -> str:
    """Composition for a catalog entry's embedding (docs request): title+
    definition only -- BRDPCatalog has no proposal column at all.
    """
    return f"{entry.title}\n\n{entry.definition}"


def compute_text_hash(text: str) -> str:
    """SHA-256 hex digest of the exact text a row's `embedding` was
    computed from, stored alongside it (embedding_text_hash) so pending-
    detection can compare it against a hash of the row's CURRENT text
    without re-embedding anything just to check (embedding_jobs.py's
    is_pending).
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# mistral-embed's real per-input context length, corroborated across
# multiple independent sources (a Weaviate integration's own error message
# literally reports "max tokens per batch: 8192" for this model; GitHub
# issues on client libraries name the same figure as the model's context
# window) -- docs.mistral.ai itself is unreachable from this sandbox (same
# network-egress limitation already documented elsewhere in this repo for
# api.mistral.ai), so this could not be re-confirmed against the primary
# docs page directly; treated as the real limit based on that convergent
# secondary evidence, not assumed from nothing.
EMBED_MAX_TOKENS_PER_INPUT = 8192

# No public exact chars-per-token ratio for mistral-embed's tokenizer is
# published anywhere this sandbox could reach -- 3 is a deliberately
# conservative (low) estimate for English/Spanish prose (the only kind of
# text BRDP title+definition+proposal / title+definition ever contains;
# Rule XML is never part of this composition), biased toward truncating a
# little early rather than risking a real 400 from the API. This is a
# proxy for a real tokenizer, not a substitute for one -- if Mistral ever
# rejects an input anyway despite this estimate (e.g. dense non-Latin
# script text tokenizing more densely than assumed), that surfaces as a
# real batch failure through the normal retry-once-then-fail path in
# embedding_jobs.py, never silently.
_CHARS_PER_TOKEN_ESTIMATE = 3
EMBED_MAX_CHARS_PER_INPUT = EMBED_MAX_TOKENS_PER_INPUT * _CHARS_PER_TOKEN_ESTIMATE

_TRUNCATION_MARKER = "\n\n[Text truncated to fit the embeddings model's ~8192-token input limit]"


def truncate_for_embedding_input(text: str) -> tuple[str, bool]:
    """HR7 -- never silently degrade: caps `text` to a length estimated to
    fit EMBED_MAX_TOKENS_PER_INPUT, with an explicit marker appended when
    it actually had to cut anything, rather than either silently sending
    a doomed over-length request or silently dropping the row. Returns
    (text_to_send, was_truncated) -- callers that persist an
    embedding_text_hash must hash the ORIGINAL untruncated text, never
    this return value's text, so pending-detection (embedding_jobs.py's
    is_pending_*) keeps comparing against the real current content, not
    a truncated proxy of it -- otherwise a row whose text needed
    truncating would look permanently "pending" the moment after it was
    just embedded.
    """
    if len(text) <= EMBED_MAX_CHARS_PER_INPUT:
        return text, False
    cut_at = max(0, EMBED_MAX_CHARS_PER_INPUT - len(_TRUNCATION_MARKER))
    return text[:cut_at] + _TRUNCATION_MARKER, True


class EmbeddingUnavailable(Exception):
    """A real, deliberate failure to compute an embedding -- misconfigured
    server settings, or the upstream call itself failing. Callers must
    treat this as "we don't know the embedding right now", never
    substitute a stale or zero vector to paper over it (HR7: never
    silently degrade) -- routes/brdps.py lets this propagate as a 502 to
    the editor who just tried to validate a BRDP; routes/similar.py lets
    it propagate too, since a /similar call that can't even embed the
    BRDP it was asked about has nothing meaningful to return.
    """


def _resolve_embed_provider() -> tuple[str, str, str]:
    settings = get_settings()
    # docs/v2 §3 point 6's own documented caveat: embeddings are Mistral-
    # only right now. Calling Mistral anyway while ACTIVE_LLM_PROVIDER is
    # "qwen" would silently break the exact data-residency guarantee that
    # setting exists to enforce -- refuse loudly instead.
    if settings.active_llm_provider != "mistral":
        detail = (
            "Embeddings are only implemented for the mistral provider (docs/v2 §3 point 6); "
            f"ACTIVE_LLM_PROVIDER is {settings.active_llm_provider!r}"
        )
        logger.error(detail)
        raise EmbeddingUnavailable(detail)
    if not settings.mistral_embed_endpoint or not settings.mistral_api_key:
        detail = "Mistral embeddings endpoint/API key is not fully configured on the server"
        logger.error(detail)
        raise EmbeddingUnavailable(detail)
    return settings.mistral_embed_endpoint, settings.mistral_api_key, settings.mistral_embed_model


# Retry-After's own spec (RFC 9110 §10.2.3) allows either an integer
# seconds count or an HTTP-date -- Mistral's real header shape wasn't
# confirmable from this sandbox (docs.mistral.ai unreachable), so both
# forms are handled rather than assuming the simpler one.
def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        target = parsedate_to_datetime(value)
        if target.tzinfo is None:
            target = target.replace(tzinfo=timezone.utc)
        return max(0.0, (target - datetime.now(timezone.utc)).total_seconds())
    except (TypeError, ValueError):
        return None


# A 429 must never fail the job outright (docs request) -- bounded so a
# misbehaving/never-recovering endpoint still eventually surfaces as a
# real, explained failure rather than hanging the background job forever.
_MAX_429_RETRIES = 5
# Used only when the response carries no Retry-After header at all --
# Mistral's exact rate-limit window wasn't confirmable from this sandbox
# either; a few seconds is a reasonable, non-aggressive default backoff,
# not a measured number.
_DEFAULT_429_WAIT_SECONDS = 5.0


async def _post_embeddings(texts: list[str], transport: httpx.AsyncBaseTransport | None) -> dict:
    """Shared low-level POST for both compute_embedding and
    compute_embeddings_batch -- same endpoint, same "input" field (a
    single-element list for one, the caller's full list for the other),
    same error/429 handling either way.
    """
    endpoint, api_key, model = _resolve_embed_provider()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    payload = {"model": model, "input": texts}

    async with httpx.AsyncClient(timeout=60.0, transport=transport) as client:
        for attempt in range(_MAX_429_RETRIES + 1):
            try:
                response = await client.post(endpoint, headers=headers, json=payload)
            except Exception:
                logger.exception("Embedding request to Mistral (%s) failed", endpoint)
                raise EmbeddingUnavailable("Embedding request failed") from None

            if response.status_code != 429:
                break

            if attempt == _MAX_429_RETRIES:
                raise EmbeddingUnavailable(
                    f"Embedding request rate-limited by Mistral (429) after {_MAX_429_RETRIES} retries"
                )
            wait_seconds = _parse_retry_after(response.headers.get("retry-after")) or _DEFAULT_429_WAIT_SECONDS
            logger.warning(
                "Mistral embeddings endpoint rate-limited (429) -- waiting %.1fs before retry %s/%s",
                wait_seconds,
                attempt + 1,
                _MAX_429_RETRIES,
            )
            await asyncio.sleep(wait_seconds)

        if response.status_code >= 400:
            logger.error(
                "Mistral embeddings endpoint (%s) returned status %s: %s",
                endpoint,
                response.status_code,
                response.text,
            )
            raise EmbeddingUnavailable(f"Embedding request failed with status {response.status_code}")

        return response.json()


async def compute_embedding(text: str, transport: httpx.AsyncBaseTransport | None = None) -> list[float]:
    """`transport` is injectable (mirrors get_httpx_transport in
    api/deps.py) so callers under FastAPI can pass through the same
    dependency-overridable transport used for llm_proxy.py's tests --
    production callers leave it None, which makes httpx use the real
    network. Kept as a single-text call for /similar's query-time
    embedding (routes/similar.py) -- that call embeds one specific BRDP
    on demand, never a batch.
    """
    body = await _post_embeddings([text], transport)
    try:
        return body["data"][0]["embedding"]
    except (KeyError, IndexError, TypeError):
        logger.error("Unexpected shape in Mistral embeddings response: %s", body)
        raise EmbeddingUnavailable("Unexpected embeddings response shape") from None


async def compute_embeddings_batch(
    texts: list[str], transport: httpx.AsyncBaseTransport | None = None
) -> list[list[float]]:
    """Sends the ENTIRE `texts` list in a single request's "input" field
    and returns one vector per text, in the SAME order as `texts` --
    docs request: matched up via each response item's own "index" field,
    never assumed to come back in request order. Never re-chunks
    internally -- the caller (embedding_jobs.py's run_embedding_job)
    decides how many texts belong in one call.
    """
    if not texts:
        return []

    body = await _post_embeddings(texts, transport)
    try:
        data = body["data"]
    except (KeyError, TypeError):
        logger.error("Unexpected shape in Mistral embeddings batch response: %s", body)
        raise EmbeddingUnavailable("Unexpected embeddings response shape") from None

    by_index: dict[int, list[float]] = {}
    for item in data:
        try:
            by_index[item["index"]] = item["embedding"]
        except (KeyError, TypeError):
            logger.error("Unexpected item shape in Mistral embeddings batch response: %s", item)
            raise EmbeddingUnavailable("Unexpected embeddings response shape") from None

    if set(by_index) != set(range(len(texts))):
        logger.error(
            "Mistral embeddings batch response index mismatch: sent %s texts, got indices %s",
            len(texts),
            sorted(by_index),
        )
        raise EmbeddingUnavailable("Embeddings batch response did not return one vector per input text")

    return [by_index[i] for i in range(len(texts))]
