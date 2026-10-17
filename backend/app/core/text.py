"""Line endings of the text people type, paste or upload (Protecciones 1c).

A text written on Windows has CRLF line endings, one from an old Mac a lone
CR. Every text that reaches a prompt or is compared literally is stored with
LF only, so the same words give the same prompt, the same word count and the
same "unchanged" whatever system wrote them. The rules (rule_xml) are NOT
normalized here: they are saved as written, like before (the UI already
sends LF; see CLAUDE.md, Protecciones 1c).

Same as normalizeNewlines in src/utils/textExtract.js and
scripts/lib/textFile.mjs -- keep them in sync.
"""

from __future__ import annotations

import re
from typing import Annotated, Any

from pydantic import BeforeValidator

_NEWLINE_RE = re.compile(r"\r\n?")


def normalize_newlines(text: str) -> str:
    """CRLF and lone CR -> LF."""
    return _NEWLINE_RE.sub("\n", text)


def _normalize_if_text(value: Any) -> Any:
    # Anything that is not a string (None, a number) is left for the field's
    # own validation to accept or refuse, as before.
    return normalize_newlines(value) if isinstance(value, str) else value


# A str field stored with LF only. Applied before max_length, so the limit
# counts the text as stored.
NormalizedText = Annotated[str, BeforeValidator(_normalize_if_text)]
