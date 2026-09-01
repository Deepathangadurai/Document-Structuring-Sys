from fastapi import APIRouter, Depends, HTTPException
from starlette.responses import JSONResponse
from app.db.database import get_engine
from app.services.qdrant_service import QdrantService
from app.api.templates import router as templates_router
from app.api.projects import router as projects_router
from app.api.documents import router as documents_router
from app.api.extraction import router as extraction_router
from app.api.model import router as model_router
from app.api.dashboard import router as dashboard_router
import sqlalchemy

router = APIRouter()

router.include_router(templates_router, prefix="", tags=["templates"])
router.include_router(projects_router, prefix="", tags=["projects"])
router.include_router(documents_router, prefix="", tags=["documents"])
router.include_router(extraction_router, prefix="", tags=["extraction"])
router.include_router(model_router, prefix="", tags=["model"])
router.include_router(dashboard_router, prefix="", tags=["dashboard"])

@router.get("/health")
async def api_health():
    return {"status": "ok", "api": "backend"}

@router.get("/health/db")
async def health_db():
    engine = get_engine()
    try:
        with engine.connect() as conn:
            conn.execute(sqlalchemy.text("SELECT 1"))
        return {"db": "ok"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"db_unavailable: {e}")

@router.get("/health/qdrant")
async def health_qdrant():
    svc = QdrantService()
    ok, details = await svc.health_check()
    if ok:
        return {"qdrant": "ok"}
    raise HTTPException(status_code=503, detail=details)