from typing import Any, cast
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.db.schemas import (
    CreateProjectRequest,
    DetectedSpecificationResponse,
    ProjectResponse,
    ProjectDetailResponse,
)
from app.services.template_service import TemplateService
from app.services.extraction_service import ProjectService
from app.services.specification_matcher import SpecificationMatcher

router = APIRouter()


@router.post("/projects", response_model=ProjectResponse)
def create_project(payload: CreateProjectRequest, db: Session = Depends(get_db)):
    template_model = None
    if payload.template_id:
        template_service = TemplateService(db)
        template_model = template_service.get_template_model(payload.template_id)
        if not template_model:
            raise HTTPException(status_code=404, detail="Template not found")

    project_service = ProjectService(db)
    project = project_service.create_project(payload.project_name, template_model, payload.project_code)
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


@router.delete("/projects/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project_service = ProjectService(db)
    deleted = project_service.delete_project(project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"deleted": True}


@router.post("/projects/{project_id}/detect-specifications", response_model=list[DetectedSpecificationResponse])
def detect_specifications(project_id: int, db: Session = Depends(get_db)):
    """Step 6/7 of the workflow: scan the project's uploaded source document
    page-by-page and report which of the master template specifications it
    contains, matched by specification number / section & field labels."""
    project_service = ProjectService(db)
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not project.documents:
        raise HTTPException(status_code=400, detail="Upload a source document before detecting specifications")

    # Most recently uploaded document — a project has exactly one source
    # document in the current workflow, but this stays correct if that
    # ever changes.
    document = max(cast(list[Any], project.documents), key=lambda d: d.id)
    if document.upload_status not in ("processed",):
        raise HTTPException(
            status_code=400,
            detail=f"Document is still being processed (status: {document.upload_status}). Try again shortly.",
        )

    matcher = SpecificationMatcher(db)
    return matcher.detect(document)