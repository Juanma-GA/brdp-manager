"""AI Extract (2/2): BRDPs from free text -- what code checks on the
decisions the AI finds (the AI proposes, code checks, people decide).

The page reads the text (pasted, or a .txt / .md / .docx / .pdf read in the
browser), asks the AI for the decisions in it -- each with the LITERAL quote
that contains it and a short title -- and posts them here. This module:

  count_words      the word limit, counted the same way as the page
                   (src/utils/textExtract.js's countWords -- keep in sync):
                   runs of characters that are not whitespace.
  paragraphs       blocks separated by a blank line.
  locate_quote     the quote must be in the text literally, with whitespace
                   normalized (any run of whitespace, line breaks included,
                   counts as one space) and Unicode NFC. Quotation marks
                   wrapped around the whole quote by the AI are not part of
                   it. A quote that is not found is never hidden: it becomes
                   an unchecked candidate with the warning.
  build_text_candidates
                   one candidate per decision: two decisions with the same
                   quote, or one quote contained in another, are a single
                   candidate (the longer quote). The identifier is never the
                   AI's: a BRDP identifier written in the quote -- or, when
                   the quote has none, the only one of its paragraph -- is
                   the origin identifier, and the candidate is classified
                   with the same code as a BREX (rule_extract_jobs's
                   classify_candidates). Found candidates come in text
                   order; the ones not found go last, in the AI's order.
"""

from __future__ import annotations

import re
import unicodedata

from app.services.rule_extract import _ID_RE

# The whitespace that separates words -- the same characters as JavaScript's
# \s, so the page and the server count the same words.
_WS = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WORD_RE = re.compile(f"[^{_WS}]+")
_WS_RUN_RE = re.compile(f"[{_WS}]+")
_BLANK_LINE_RE = re.compile(r"\r?\n[ \t\u00a0]*\r?\n")
_WRAPPING_QUOTES = {'"': '"', "'": "'", "“": "”", "‘": "’", "«": "»", "„": "“"}

MAX_TITLE_CHARS = 300
MAX_QUOTE_CHARS = 4000


def count_words(text: str) -> int:
    return len(_WORD_RE.findall(text or ""))


def normalize_ws(text: str) -> str:
    return _WS_RUN_RE.sub(" ", unicodedata.normalize("NFC", text or "")).strip()


def paragraphs(text: str) -> list[str]:
    """Blocks separated by a blank line, without the empty ones."""
    return [p for p in (b.strip() for b in _BLANK_LINE_RE.split(text or "")) if p]


class _Located:
    def __init__(self, quote: str, start: int, paragraph_indexes: list[int]):
        self.quote = quote
        self.start = start
        self.paragraph_indexes = paragraph_indexes


class SourceText:
    """The text, its paragraphs, and their whitespace-normalized form joined
    by single spaces (a quote that spans two paragraphs is found too)."""

    def __init__(self, text: str):
        self.paragraphs = paragraphs(text)
        self.normalized = [normalize_ws(p) for p in self.paragraphs]
        self.offsets: list[int] = []
        pos = 0
        for n in self.normalized:
            self.offsets.append(pos)
            pos += len(n) + 1
        self.joined = " ".join(self.normalized)

    def locate(self, quote: str) -> _Located | None:
        q = normalize_ws(quote)
        tries = [q]
        if len(q) > 2 and _WRAPPING_QUOTES.get(q[0]) == q[-1]:
            tries.append(q[1:-1].strip())
        for t in tries:
            if not t:
                continue
            start = self.joined.find(t)
            if start == -1:
                continue
            end = start + len(t)
            indexes = [i for i, off in enumerate(self.offsets) if off < end and off + len(self.normalized[i]) > start]
            return _Located(t, start, indexes)
        return None


def _identifiers(text: str) -> list[str]:
    return list(dict.fromkeys(m.group(1) for m in _ID_RE.finditer(text or "")))


def _contains(a: str, b: str) -> bool:
    """a contains b (both normalized)."""
    return bool(b) and b in a


def build_text_candidates(text: str, decisions: list[dict]) -> list[dict]:
    """decisions: [{quote, title}] as the AI gave them (the route validated
    their shape). Returns the candidates, before classification."""
    source = SourceText(text)
    found: list[dict] = []
    missing: list[dict] = []
    for d in decisions:
        quote = (d.get("quote") or "").strip()
        title = normalize_ws(d.get("title") or "")[:MAX_TITLE_CHARS]
        if not quote:
            continue
        located = source.locate(quote)
        item = {"title": title}
        if located is None:
            item.update({"quote": normalize_ws(quote), "found": False, "start": None, "paragraphs": []})
            missing.append(item)
        else:
            item.update({"quote": located.quote, "found": True, "start": located.start, "paragraphs": located.paragraph_indexes})
            found.append(item)

    # Same quote, or one quote inside another: a single candidate, the
    # longer quote (with its title, or the other's when it has none).
    merged: list[dict] = []
    for item in sorted(found, key=lambda i: -len(i["quote"])) + sorted(missing, key=lambda i: -len(i["quote"])):
        into = next((m for m in merged if _contains(m["quote"], item["quote"])), None)
        if into is None:
            item["merged"] = 0
            merged.append(item)
            continue
        into["merged"] += 1
        if not into["title"] and item["title"]:
            into["title"] = item["title"]
        if not into["found"] and item["found"]:
            into.update({k: item[k] for k in ("found", "start", "paragraphs")})
    ordered = sorted((m for m in merged if m["found"]), key=lambda m: m["start"]) + [m for m in merged if not m["found"]]

    candidates = []
    for position, m in enumerate(ordered, start=1):
        paragraph = "\n\n".join(source.paragraphs[i] for i in m["paragraphs"])
        in_quote = _identifiers(m["quote"])
        in_paragraph = _identifiers(paragraph)
        origin = in_quote[0] if in_quote else (in_paragraph[0] if len(in_paragraph) == 1 else None)
        warnings = []
        if not m["found"]:
            warnings.append(
                {"code": "quote_not_found", "params": {}, "message": "The quote was not found in the text."}
            )
        if not in_quote and len(in_paragraph) > 1:
            warnings.append(
                {
                    "code": "paragraph_several_identifiers",
                    "params": {"ids": in_paragraph},
                    "message": f"Its paragraph names several identifiers ({', '.join(in_paragraph)}); none was taken.",
                }
            )
        candidates.append(
            {
                "key": f"c{position:05d}",
                "source": "text",
                "origin_identifier": origin,
                "identifier": None,
                "quote": m["quote"][:MAX_QUOTE_CHARS],
                "quote_found": m["found"],
                "paragraph": paragraph,
                "found_title": m["title"],
                "merged_count": m["merged"],
                "rule_xml": "",
                "rule_count": 0,
                "noncontext_count": 0,
                "rule_preview": [],
                "decision_texts": [],
                "object_uses": [],
                "summary": None,
                "literal": {},
                "no_content": False,
                "warnings": warnings,
            }
        )
    return candidates
