from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import router as api_router
from app.core.config import settings
from app.db.database import engine, SessionLocal, Base, run_startup_migrations
from app.services.template_service import TemplateService
from app.db.models import ExtractionJob

app = FastAPI(title="Document Structuring System - Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rendered template page images (and other generated assets) live under
# STORAGE_PATH on disk. Without this mount there is no HTTP route that can
# ever serve them, so an <img src="..."> pointing at a page image can never
# load no matter what path the API returns for it.
_storage_path = Path(settings.STORAGE_PATH)
_storage_path.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_storage_path)), name="static")

@app.on_event("startup")
async def startup_event():
    Base.metadata.create_all(bind=engine)
    run_startup_migrations(engine)
    with SessionLocal() as db:
        TemplateService(db).sync_templates()
        _recover_orphaned_extraction_jobs(db)


def _recover_orphaned_extraction_jobs(db) -> None:
    """Extraction runs as a FastAPI BackgroundTask inside this same process
    (see extraction_service.process_job) - there's no separate worker, no
    queue, and nothing that survives this process exiting. So if the
    backend is starting up right now, any job still marked "processing" in
    the DB cannot possibly have anything still running for it - it was
    orphaned by whatever stopped the previous process (restart, crash,
    redeploy) partway through. Left alone it just sits there forever
    looking "stuck" at its last progress%. Mark it failed with a clear,
    actionable message instead of a silent hang; fields saved by earlier
    chunks (see _upsert_extracted_fields) are untouched, so the user only
    needs to re-run extraction, not re-do everything.
    """
    orphaned = db.query(ExtractionJob).filter_by(status="processing").all()
    for job in orphaned:
        job.status = "failed"  # type: ignore[assignment]
        job.error_message = (  # type: ignore[assignment]
            "Extraction was interrupted by a server restart before it finished. "
            "Any fields already saved from earlier pages are kept - re-run "
            "extraction to pick up the rest."
        )
        db.add(job)
    if orphaned:
        db.commit()

@app.get("/")
async def root():
    return {
        "message": "Document Structuring System API is running",
        "docs": "/docs",
        "health": "/health",
    }

app.include_router(api_router.router, prefix="/api")

@app.get("/health")
async def health():
    return {"status": "ok"}