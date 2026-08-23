import tempfile
from pathlib import Path
from typing import cast
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.services.extraction_service import ExtractionService, ProjectService
from app.services.template_service import TemplateService
from app.services.verification_service import VerificationService
from app.db.schemas import (
    CreateExtractionRequest,
    ExtractionJobResponse,
    FieldUpdateRequest,
    ExtractedFieldResponse,
    FieldVerificationResponse,
)

router = APIRouter()

ALLOWED_VALIDATION_STATUSES = {"pending", "verified", "missing", "review", "rejected"}

@router.post("/projects/{project_id}/extract", response_model=ExtractionJobResponse)
def start_extraction(project_id: int, payload: CreateExtractionRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    project_service = ProjectService(db)
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    document = project_service.get_document(payload.document_id)
    if not document or cast(int, document.project_id) != project_id:
        raise HTTPException(status_code=404, detail="Document not found for this project")

    # `payload.template_id` is the matched specification (from
    # /detect-specifications) this extraction job is for. Falls back to
    # the project's own template for the old single-template flow.
    template_model = None
    if payload.template_id:
        template_service = TemplateService(db)
        template_model = template_service.get_template_model(payload.template_id)
        if not template_model:
            raise HTTPException(status_code=404, detail="Template not found")
    elif project.template_id is None:
        raise HTTPException(
            status_code=400,
            detail="template_id is required: no specification was matched and this project has no default template",
        )

    extraction_service = ExtractionService(db)
    job = extraction_service.create_job(project, document, template_model)

    # Use cast to inform Pyright that job.id is an integer at runtime
    job_id = cast(int, job.id)
    background_tasks.add_task(extraction_service.process_job, job_id)

    return extraction_service.get_job_results(job)

@router.get("/extraction/{job_id}", response_model=ExtractionJobResponse)
def get_extraction(job_id: int, db: Session = Depends(get_db)):
    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    return extraction_service.get_job_results(job)

@router.get("/extraction/{job_id}/results", response_model=ExtractionJobResponse)
def get_extraction_results(job_id: int, db: Session = Depends(get_db)):
    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    return extraction_service.get_job_results(job)

@router.get("/extraction/{job_id}/verify", response_model=list[FieldVerificationResponse])
def verify_extraction(job_id: int, db: Session = Depends(get_db)):
    """Requirement #10: "Verify Document & Template" - compares every
    extracted value against what the matched master template requires and
    returns MATCH / MISMATCH / NOT FOUND / REVIEW per field. Also persists
    the verdicts onto the ExtractedField rows so they show up in normal
    job results without having to re-run verification every time."""
    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    if job.status != "completed":  # type: ignore[comparison-overlap]
        raise HTTPException(status_code=400, detail="Extraction job has not completed yet")

    verification_service = VerificationService(db)
    results = verification_service.verify_job(job)
    extraction_service.store_verification_results(job_id, results)
    return results

@router.get("/extraction/{job_id}/export")
def export_extraction(job_id: int, format: str = "json", db: Session = Depends(get_db)):
    """Download the structured output. There was previously no download
    path anywhere in the app -- results only ever lived on-screen in the
    upload wizard's last step."""
    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    if job.status != "completed":  # type: ignore[comparison-overlap]
        raise HTTPException(status_code=400, detail="Extraction job has not completed yet")

    if format == "json":
        data = extraction_service.build_export_data(job)
        return JSONResponse(
            content=data,
            headers={"Content-Disposition": f'attachment; filename="extraction_{job_id}.json"'},
        )

    if format == "docx":
        tmp_dir = tempfile.mkdtemp()
        output_path = Path(tmp_dir) / f"extraction_{job_id}.docx"
        extraction_service.export_as_docx(job, str(output_path))
        return FileResponse(
            str(output_path),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=f"extraction_{job_id}.docx",
        )

    raise HTTPException(status_code=400, detail="format must be 'json' or 'docx'")

@router.patch("/extraction/{job_id}/fields/{field_id}", response_model=ExtractedFieldResponse)
def update_extracted_field(job_id: int, field_id: str, payload: FieldUpdateRequest, db: Session = Depends(get_db)):
    if payload.validation_status not in ALLOWED_VALIDATION_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"validation_status must be one of {sorted(ALLOWED_VALIDATION_STATUSES)}",
        )
    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")

    field = extraction_service.update_field(job_id, field_id, payload.value, payload.validation_status)
    if not field:
        raise HTTPException(status_code=404, detail="Field not found for this extraction job")

    return {
        "field_id": field.field_id,
        "field_label": field.field_label,
        "value": field.value,
        "original_value": field.original_value,
        "confidence": field.confidence,
        "validation_status": field.validation_status,
        "verification_status": field.verification_status,
        "is_dynamic": field.is_dynamic,
        "source_references": [
            {
                "page_number": source.page_number,
                "source_text": source.source_text,
                "confidence": source.confidence,
                "bounding_box": source.bounding_box,
            }
            for source in field.source_references
        ],
    }