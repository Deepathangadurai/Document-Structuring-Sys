"""HTTP client for Gotenberg (https://gotenberg.dev), a containerized
LibreOffice conversion service.

Why this exists: shelling out to a `soffice` binary installed directly on
the host (the previous/still-available path in schema_inference.py) means
document conversion is only as reliable as that host install - a stale
profile lock, a partial update, or a corrupted config file (e.g.
`bootstrap.ini`, the exact failure this module is here to route around)
takes down every upload until someone repairs or reinstalls it by hand.

Gotenberg runs LibreOffice inside a disposable Docker container and
exposes it over HTTP instead. Every conversion request gets a fresh
container-local LibreOffice - nothing persists between requests, so
there's no host install to corrupt in the first place. This client is a
thin wrapper around its `/forms/libreoffice/convert` endpoint
(https://gotenberg.dev/docs/routes#libreoffice) for docx -> pdf.

Gotenberg only converts *to* PDF - it doesn't do docx <-> docx (e.g. the
legacy .doc -> .docx upgrade path), so that conversion still goes through
soffice/Word directly (see _convert_doc_to_docx in schema_inference.py /
document_service.py). This client only replaces the docx -> pdf step,
which is the one actually needed for page images and page-accurate text.
"""
import logging
import time
from pathlib import Path

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Circuit breaker: if Gotenberg is unreachable/misconfigured, don't retry
# it (and pay its connect-timeout) on every single document for the rest
# of the process's life. Trip it open for a cooldown window, then let one
# request through to test recovery - the same pattern used for a flaky
# downstream dependency anywhere else.
_BREAKER_COOLDOWN_SECONDS = 300  # 5 minutes
_breaker_open_until: float = 0.0


def _breaker_is_open() -> bool:
    return time.monotonic() < _breaker_open_until


def _trip_breaker() -> None:
    global _breaker_open_until
    _breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_SECONDS
    logger.warning(
        "Gotenberg conversion failed - backing off for %ss before trying again",
        _BREAKER_COOLDOWN_SECONDS,
    )


def _reset_breaker() -> None:
    global _breaker_open_until
    if _breaker_open_until:
        logger.info("Gotenberg conversion succeeded again - clearing backoff")
    _breaker_open_until = 0.0


def is_configured() -> bool:
    return bool(settings.GOTENBERG_URL)


def is_available() -> bool:
    """Cheap reachability check, used for health reporting - does not
    consume/trip the circuit breaker itself."""
    if not is_configured():
        return False
    try:
        base = settings.GOTENBERG_URL.rstrip("/")
        with httpx.Client(timeout=5) as client:
            response = client.get(f"{base}/health")
            return response.status_code == 200
    except Exception:
        return False


def convert_docx_to_pdf(docx_path: Path, output_dir: Path) -> Path:
    """Convert a .docx to PDF via a Gotenberg container.

    Raises on any failure (unconfigured, breaker open, connection refused,
    non-2xx response, timeout) - callers are expected to catch and fall
    back to the direct soffice/Word path, exactly as they already do for
    those.
    """
    if not is_configured():
        raise RuntimeError("GOTENBERG_URL is not configured")
    if _breaker_is_open():
        raise RuntimeError("Gotenberg circuit breaker is open (recent failure) - skipping")

    base = settings.GOTENBERG_URL.rstrip("/")
    url = f"{base}/forms/libreoffice/convert"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / (docx_path.stem + ".pdf")

    try:
        with docx_path.open("rb") as fh:
            files = {"files": (docx_path.name, fh, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}
            with httpx.Client(timeout=settings.GOTENBERG_TIMEOUT_SECONDS) as client:
                response = client.post(url, files=files)
        response.raise_for_status()
        output_path.write_bytes(response.content)
    except Exception as exc:
        _trip_breaker()
        logger.warning("Gotenberg conversion failed for %s: %r", docx_path, exc)
        raise

    _reset_breaker()
    return output_path