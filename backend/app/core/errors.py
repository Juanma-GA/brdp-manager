"""Sanitized errors (AACF Decisión 12): the user gets a stable code and a
reference, the technical detail goes to the server log under that same
reference.

An error nobody expected (any exception a route did not turn into an
HTTPException) is answered by SanitizedErrorMiddleware with

    {"detail": {"code": "internal_error", "ref": "1a2b3c4d"}}      500

or, when the database is behind the code (a table the migrations create is
missing), {"code": "database_not_migrated", "ref": ...} with 503. The
exception's text, its class and the database's own message never reach the
response; `logger.exception` records them, with the traceback and the
request, under "ref=<ref>" -- the reference the frontend shows ("ref. …")
so the log line can be found.

The frontend translates the code into a sentence (src/services/apiErrors.js).
"""
import logging
import secrets

from sqlalchemy.exc import ProgrammingError
from starlette.responses import JSONResponse

logger = logging.getLogger("app.errors")


def new_error_ref() -> str:
    """A short reference shown to the user and written in the log line."""
    return secrets.token_hex(4)


def error_detail(code: str, ref: str | None = None, **params) -> dict:
    """The `detail` of a sanitized error: a code the frontend translates,
    the reference when there is a log line to find, and plain parameters."""
    detail = {"code": code, **params}
    if ref:
        detail["ref"] = ref
    return detail


def _is_missing_table(exc: Exception) -> bool:
    orig = getattr(exc, "orig", None)
    text = f"{type(orig).__name__ if orig is not None else ''} {orig if orig is not None else exc}"
    return isinstance(exc, ProgrammingError) and ("UndefinedTable" in text or ("relation" in text and "does not exist" in text))


def unexpected_error_response(exc: Exception, method: str, path: str) -> JSONResponse:
    """Logs the exception under a new reference and answers with its code."""
    ref = new_error_ref()
    if _is_missing_table(exc):
        logger.exception(
            "ref=%s %s %s failed: a table is missing -- the migrations have not been applied (run `alembic upgrade head`)",
            ref,
            method,
            path,
        )
        return JSONResponse(status_code=503, content={"detail": error_detail("database_not_migrated", ref)})
    logger.exception("ref=%s %s %s failed with an unexpected error", ref, method, path)
    return JSONResponse(status_code=500, content={"detail": error_detail("internal_error", ref)})


class SanitizedErrorMiddleware:
    """Pure ASGI middleware: catches an exception that escaped every route
    and handler before the response started, and answers it sanitized. Once
    a response has started (a stream already sending), nothing else can be
    sent: the exception is logged and re-raised."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_wrapper(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:  # noqa: BLE001 -- answered sanitized, logged in full
            if started:
                logger.exception("%s %s failed after its response had started", scope.get("method"), scope.get("path"))
                raise
            response = unexpected_error_response(exc, scope.get("method", ""), scope.get("path", ""))
            await response(scope, receive, send)
