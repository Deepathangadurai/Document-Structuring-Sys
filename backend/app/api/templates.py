from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.db.schemas import (
    TemplateListResponse,
    TemplateDetailResponse,
    TemplatePreviewResponse,
    PendingTemplateResponse,
    PendingTemplateUpdateRequest,
)
from app.services.template_service import TemplateService
from app.services.page_analysis_service import PageAnalysisService
from pydantic import BaseModel
from typing import Optional, Any, List

router = APIRouter()

# --- Request/Response Models for Page Analysis ---

class PageAnalysisRequest(BaseModel):
    page_number: int
    page_text: Optional[str] = None
    extracted_fields: List[dict[str, Any]] = []

class PageValidationRequest(BaseModel):
    page_number: int
    page_text: str
    extracted_fields: List[dict[str, Any]] = []

class PageUserFeedbackRequest(BaseModel):
    page_number: int
    corrections: dict[str, Any] = {}
    approved_fields: List[str] = []
    notes: Optional[str] = None

class FinalizeMasterTemplateRequest(BaseModel):
    final_schema: dict[str, Any]
    validation_summary: dict[str, Any]

# NOTE: /templates/pending routes are declared before /templates/{template_id}
# so "pending" is never swallowed by the {template_id} path parameter.

@router.get("/templates/pending", response_model=list[PendingTemplateResponse])
def list_pending_templates(db: Session = Depends(get_db)):
    service = TemplateService(db)
    return service.list_pending_templates()

@router.post("/templates/upload", response_model=PendingTemplateResponse)
def upload_template(file: UploadFile = File(...), db: Session = Depends(get_db)):
    service = TemplateService(db)
    try:
        return service.create_pending_template(file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.get("/templates/pending/{pending_id}", response_model=PendingTemplateResponse)
def get_pending_template(pending_id: int, db: Session = Depends(get_db)):
    service = TemplateService(db)
    template = service.get_pending_template(pending_id)
    if not template:
        raise HTTPException(status_code=404, detail="Pending template not found")
    return service.to_pending_response(template)

@router.patch("/templates/pending/{pending_id}", response_model=PendingTemplateResponse)
def update_pending_template(pending_id: int, payload: PendingTemplateUpdateRequest, db: Session = Depends(get_db)):
    service = TemplateService(db)
    updates = payload.model_dump(exclude_unset=True)
    result = service.update_pending_template(pending_id, updates)
    if not result:
        raise HTTPException(status_code=404, detail="Pending template not found")
    return result

@router.post("/templates/pending/{pending_id}/approve", response_model=TemplateDetailResponse)
def approve_pending_template(pending_id: int, db: Session = Depends(get_db)):
    service = TemplateService(db)
    try:
        return service.approve_pending_template(pending_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.delete("/templates/pending/{pending_id}")
def reject_pending_template(pending_id: int, db: Session = Depends(get_db)):
    service = TemplateService(db)
    ok = service.reject_pending_template(pending_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Pending template not found")
    return {"deleted": True}

@router.get("/templates", response_model=list[TemplateListResponse])
def list_templates(db: Session = Depends(get_db)):
    service = TemplateService(db)
    return service.list_templates()

@router.get("/templates/{template_id}", response_model=TemplateDetailResponse)
def get_template(template_id: str, db: Session = Depends(get_db)):
    service = TemplateService(db)
    template = service.get_template(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    return template

@router.delete("/templates/{template_id}")
def delete_template(template_id: str, force: bool = False, db: Session = Depends(get_db)):
    service = TemplateService(db)
    try:
        service.delete_template(template_id, force=force)
    except ValueError as exc:
        # "not found" and "in use" both come through here - the message
        # itself is what distinguishes them for the caller.
        status = 404 if "not found" in str(exc).lower() else 400
        raise HTTPException(status_code=status, detail=str(exc))
    return {"deleted": True}

@router.get("/templates/{template_id}/preview", response_model=TemplatePreviewResponse)
def preview_template(template_id: str, db: Session = Depends(get_db)):
    service = TemplateService(db)
    template = service.get_template(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    return template

# --- Page-by-Page Template Analysis Endpoints ---

@router.post("/templates/pending/{pending_id}/pages/{page_number}/analyze")
def analyze_page(
    pending_id: int,
    page_number: int,
    payload: PageAnalysisRequest,
    db: Session = Depends(get_db),
):
    """
    Analyze a specific page of the pending template.
    Returns structure summary and extracted fields.
    """
    try:
        service = PageAnalysisService(db)
        schema = service.get_page_preview(pending_id, page_number)
        
        result = service.analyze_page_structure(
            pending_id,
            page_number,
            schema.get("page_image_url", ""),
            payload.extracted_fields,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(exc)}")

@router.post("/templates/pending/{pending_id}/pages/{page_number}/validate")
def validate_page_with_model(
    pending_id: int,
    page_number: int,
    payload: PageValidationRequest,
    db: Session = Depends(get_db),
):
    """
    Use Ollama to validate and extract field values from a page.
    Returns validated fields with confidence scores and suggestions.
    """
    try:
        service = PageAnalysisService(db)
        result = service.validate_page_with_ollama(
            pending_id,
            page_number,
            payload.page_text,
            payload.extracted_fields,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Validation failed: {str(exc)}")

@router.post("/templates/pending/{pending_id}/pages/{page_number}/feedback")
def submit_page_feedback(
    pending_id: int,
    page_number: int,
    payload: PageUserFeedbackRequest,
    db: Session = Depends(get_db),
):
    """
    Record user validation feedback for a page.
    Stores corrections, approvals, and notes.
    """
    try:
        service = PageAnalysisService(db)
        result = service.collect_user_validation(
            pending_id,
            page_number,
            payload.model_dump(),
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to store feedback: {str(exc)}")

@router.get("/templates/pending/{pending_id}/pages/{page_number}/preview")
def get_page_preview(
    pending_id: int,
    page_number: int,
    db: Session = Depends(get_db),
):
    """
    Get preview data for a specific page during template review.
    Includes page image, fields, and sections on that page.
    """
    try:
        service = PageAnalysisService(db)
        result = service.get_page_preview(pending_id, page_number)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Preview retrieval failed: {str(exc)}")

@router.post("/templates/pending/{pending_id}/finalize")
def finalize_master_template(
    pending_id: int,
    payload: FinalizeMasterTemplateRequest,
    db: Session = Depends(get_db),
):
    """
    Finalize the master template after all pages have been reviewed.
    Transitions the template from pending to approved status.
    """
    try:
        service = PageAnalysisService(db)
        result = service.finalize_master_template(
            pending_id,
            payload.final_schema,
            payload.validation_summary,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Finalization failed: {str(exc)}")