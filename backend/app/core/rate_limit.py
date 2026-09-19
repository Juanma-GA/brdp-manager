"""Simple in-process brute-force guard for POST /api/auth/login (docs/v2
§9 follow-up: nginx's gateway rate limiting, §5.1, is generic per-IP/path
throttling -- it does not specifically stop repeated password guesses
against one account from rotating source IPs).

TODO before production: this is an in-memory, single-process counter. It
resets on restart and does NOT share state across multiple uvicorn workers
or replicas, so it under-counts (and therefore under-protects) as soon as
the app runs with more than one process. Move to a shared store (Redis) or
a gateway-level per-account rule if that becomes the deployment shape --
tracked here rather than silently assumed to be "handled by nginx".
"""
import time
from collections import defaultdict

_MAX_ATTEMPTS = 5
_WINDOW_SECONDS = 15 * 60

_failed_attempts: dict[str, list[float]] = defaultdict(list)


def is_locked_out(email: str) -> bool:
    now = time.monotonic()
    attempts = [t for t in _failed_attempts[email] if now - t < _WINDOW_SECONDS]
    _failed_attempts[email] = attempts
    return len(attempts) >= _MAX_ATTEMPTS


def record_failed_attempt(email: str) -> None:
    _failed_attempts[email].append(time.monotonic())


def clear_attempts(email: str) -> None:
    _failed_attempts.pop(email, None)
