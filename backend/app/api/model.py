from fastapi import APIRouter
from app.services.model import ModelService
from app.db.schemas import ModelHealthResponse

router = APIRouter()

@router.get("/model/health", response_model=ModelHealthResponse)
def model_health():
    model_service = ModelService()
    return model_service.health()
