from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import router as api_router
from app.core.config import settings
from app.db.database import engine, SessionLocal, Base, run_startup_migrations
from app.services.template_service import TemplateService

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