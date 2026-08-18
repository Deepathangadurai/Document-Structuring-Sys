from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.db.schemas import CreateProjectRequest, ProjectResponse, ProjectDetailResponse
from app.services.template_service import TemplateService
from app.services.extraction_service import ProjectService

router = APIRouter()


@router.post("/projects", response_model=ProjectResponse)
def create_project(payload: CreateProjectRequest, db: Session = Depends(get_db)):
    template_service = TemplateService(db)
    template_model = template_service.get_template_model(payload.template_id)
    if not template_model:
        raise HTTPException(status_code=404, detail="Template not found")

    project_service = ProjectService(db)
    project = project_service.create_project(payload.project_name, template_model)
    return project_service._to_response(project)


@router.get("/projects", response_model=list[ProjectResponse])
def list_projects(limit: int = 100, offset: int = 0, db: Session = Depends(get_db)):
    project_service = ProjectService(db)
    return project_service.list_projects(limit=limit, offset=offset)


@router.get("/projects/{project_id}", response_model=ProjectDetailResponse)
def get_project(project_id: int, db: Session = Depends(get_db)):
    project_service = ProjectService(db)
    project_detail = project_service.get_project_detail(project_id)
    if not project_detail:
        raise HTTPException(status_code=404, detail="Project not found")
    return project_detail