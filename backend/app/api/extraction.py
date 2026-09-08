import tempfile
import threading
from pathlib import Path
from typing import Any, cast, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse
from sqlalchemy.orm import Session
from app.db.database import get_db, SessionLocal
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

ALLOWED_VALIDATION_STATUSES = {"pending", "verified", "missing", "review", "rejected", "default"}


def _run_extraction_in_thread(job_id: int) -> None:
    """Run process_job in a dedicated daemon thread with its own DB session.

    FastAPI's BackgroundTasks runs the callable on the same event loop /
    thread that served the request, and reuses the *request's* DB session.
    That has two problems for a long-running extraction job:

    1. The request's Session is not thread-safe and may already be closed by
       the time a background task uses it.
    2. Every DB commit inside process_job holds SQLite's write lock; other
       API requests (status polls, page loads) that also write block until
       the commit finishes - making the server appear completely frozen.

    Running in a proper daemon thread with its own SessionLocal fixes both:
    the session is owned and closed by this thread alone, and WAL mode
    (enabled in database.py) lets readers continue in parallel with writes.
    """
    with SessionLocal() as db:
        service = ExtractionService(db)
        service.process_job(job_id)


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

    # Spawn a daemon thread so extraction runs completely independently of
    # this request/response cycle. The thread gets its own DB session (see
    # _run_extraction_in_thread) so it never contends with the request
    # session for the write lock. daemon=True means the thread won't prevent
    # the server process from exiting if the server is stopped mid-job (the
    # startup recovery logic in main.py handles that case).
    thread = threading.Thread(
        target=_run_extraction_in_thread,
        args=(job_id,),
        daemon=True,
        name=f"extraction-job-{job_id}",
    )
    thread.start()

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

@router.delete("/extraction/{job_id}")
def delete_extraction(job_id: int, db: Session = Depends(get_db)):
    project_service = ProjectService(db)
    deleted = project_service.delete_extraction_job(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    return {"deleted": True}

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

    if format == "pdf":
        from app.services.document_export_service import DocumentExportService
        tmp_dir = tempfile.mkdtemp()
        docx_output_path = Path(tmp_dir) / f"extraction_{job_id}.docx"
        extraction_service.export_as_docx(job, str(docx_output_path))
        try:
            pdf_path = DocumentExportService.convert_docx_to_pdf(str(docx_output_path))
            return FileResponse(
                pdf_path,
                media_type="application/pdf",
                filename=f"extraction_{job_id}.pdf",
            )
        except Exception:
            return FileResponse(
                str(docx_output_path),
                media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                filename=f"extraction_{job_id}.docx",
            )

    raise HTTPException(status_code=400, detail="format must be 'json', 'docx', or 'pdf'")


@router.get("/extraction/{job_id}/preview/pdf")
def preview_extraction_pdf(job_id: int, db: Session = Depends(get_db)):
    """Stream the true PDF export of the final populated document for inline viewing."""
    from app.services.document_export_service import DocumentExportService

    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    if job.status != "completed":
        raise HTTPException(status_code=400, detail="Extraction job has not completed yet")

    tmp_dir = tempfile.mkdtemp()
    docx_output_path = Path(tmp_dir) / f"extraction_{job_id}.docx"
    extraction_service.export_as_docx(job, str(docx_output_path))
    try:
        pdf_path = DocumentExportService.convert_docx_to_pdf(str(docx_output_path))
        return FileResponse(
            pdf_path,
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="preview_{job_id}.pdf"'},
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"PDF preview generation failed: {exc}")


def _get_or_render_preview_pages(job, extraction_service) -> tuple[Path, int]:
    """
    Renders all pages of the populated document to PNG images in a cached directory.
    Invalidates automatically when job status or field values change.
    Returns (cache_dir, total_pages).
    """
    import hashlib
    import json
    import fitz
    from app.services.document_export_service import DocumentExportService

    # Signature based on job id, status, extracted fields, and populated_tree to automatically invalidate cache on any edit
    fields_sig = "".join(f"{f.field_id}:{f.value}" for f in sorted(job.extracted_fields or [], key=lambda x: x.field_id))
    tree_sig = str(len(json.dumps(job.populated_tree))) if job.populated_tree else ""
    hash_key = hashlib.md5(f"{job.id}_{job.status}_{fields_sig}_{tree_sig}".encode()).hexdigest()[:12]

    cache_dir = Path(tempfile.gettempdir()) / f"dss_preview_{job.id}_{hash_key}"
    info_file = cache_dir / "info.json"

    if cache_dir.exists() and info_file.exists():
        try:
            with open(info_file, "r") as f:
                info = json.load(f)
                return cache_dir, info.get("total_pages", 1)
        except Exception:
            pass

    cache_dir.mkdir(parents=True, exist_ok=True)
    docx_output_path = cache_dir / f"extraction_{job.id}.docx"
    extraction_service.export_as_docx(job, str(docx_output_path))
    pdf_path = DocumentExportService.convert_docx_to_pdf(str(docx_output_path))

    pdf_doc = fitz.open(pdf_path)
    total_pages = len(pdf_doc)

    mat = fitz.Matrix(150 / 72, 150 / 72)  # 150 DPI for crisp preview
    for p_idx in range(total_pages):
        page = pdf_doc[p_idx]
        pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB, alpha=False)
        img_path = cache_dir / f"page_{p_idx + 1}.png"
        pix.save(str(img_path))

    pdf_doc.close()

    try:
        with open(info_file, "w") as f:
            json.dump({"total_pages": total_pages}, f)
    except Exception:
        pass

    return cache_dir, total_pages


@router.get("/extraction/{job_id}/preview/page/{page_number}")
def preview_extraction_page_image(job_id: int, page_number: int, db: Session = Depends(get_db)):
    """
    Render a specific page of the final populated PDF output as a high-resolution PNG image.
    This guarantees a 100% exact match with the downloaded PDF/DOCX file.
    """
    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    if job.status != "completed":
        raise HTTPException(status_code=400, detail="Extraction job has not completed yet")

    try:
        cache_dir, total_pages = _get_or_render_preview_pages(job, extraction_service)
        if page_number < 1 or page_number > total_pages:
            raise HTTPException(status_code=404, detail=f"Page {page_number} out of range (total pages: {total_pages})")

        img_output_path = cache_dir / f"page_{page_number}.png"
        if not img_output_path.exists():
            raise HTTPException(status_code=404, detail=f"Page image {page_number} not found")

        return FileResponse(
            str(img_output_path),
            media_type="image/png",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
                "X-Total-Pages": str(total_pages),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to render page image: {exc}")


@router.get("/extraction/{job_id}/preview/info")
def preview_extraction_info(job_id: int, db: Session = Depends(get_db)):
    """Get metadata (total pages) for the true rendered PDF output document."""
    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")
    if job.status != "completed":
        raise HTTPException(status_code=400, detail="Extraction job has not completed yet")

    try:
        _, total_pages = _get_or_render_preview_pages(job, extraction_service)
        return {"job_id": job_id, "total_pages": total_pages}
    except Exception as exc:
        return {"job_id": job_id, "total_pages": job.total_pages or 1, "error": str(exc)}

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
        "default_value": getattr(field, "default_value", None),
        "is_default": field.validation_status == "default",
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


class BlockUpdateRequest(BaseModel):
    text: Optional[str] = None
    table_data: Optional[list[list[str]]] = None


@router.patch("/extraction/{job_id}/blocks/{block_id}")
def update_extracted_block(
    job_id: int,
    block_id: str,
    payload: BlockUpdateRequest,
    db: Session = Depends(get_db),
):
    """Update static document block/paragraph/table in populated_tree."""
    extraction_service = ExtractionService(db)
    updated = extraction_service.update_block(
        job_id,
        block_id,
        new_text=payload.text,
        new_table_data=payload.table_data,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Block not found for this extraction job")
    return {
        "success": True,
        "block_id": block_id,
        "text": payload.text,
        "table_data": payload.table_data,
    }


@router.get("/extraction/{job_id}/structural-check")
def structural_check(job_id: int, db: Session = Depends(get_db)):
    """
    Presence-based structural check: does the source document contain the
    expected labels from the master schema, regardless of page order?

    Returns {status, details} where status ∈ {MATCH, REVIEW, MISMATCH}.
    Call this before opening the editor to decide whether to show a warning.
    """
    from app.db.models import DocumentPage, Template
    from app.services.template_validator import DocumentTemplateValidator

    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")

    template = db.query(Template).filter_by(id=job.template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    pages = (
        db.query(DocumentPage)
        .filter_by(document_id=job.document_id)
        .order_by(DocumentPage.page_number)
        .all()
    )
    page_dicts = [{"page_number": p.page_number, "text": p.text or ""} for p in pages]
    schema_dict: dict[str, Any] = cast(dict, template.schema)

    result = DocumentTemplateValidator.validate_pre_extraction(schema_dict, page_dicts)
    return {"status": result.status, "details": result.details}


@router.get("/extraction/{job_id}/validate-output")
def validate_output(job_id: int, db: Session = Depends(get_db)):
    """
    Pre-download structural re-check: generate the output docx in a temp
    directory and run DocumentTemplateValidator.validate_pre_download on it.

    Returns {status, details}.  The frontend shows this result inline before
    handing the file to the user.  The actual download still uses /export.
    """
    import tempfile
    from app.db.models import Template
    from app.services.template_validator import DocumentTemplateValidator

    extraction_service = ExtractionService(db)
    job = extraction_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Extraction job not found")

    template = db.query(Template).filter_by(id=job.template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir) / "output_check.docx"
            extraction_service.export_as_docx(job, str(tmp_path))
            schema_dict: dict[str, Any] = cast(dict, template.schema)
            result = DocumentTemplateValidator.validate_pre_download(schema_dict, tmp_path)
    except Exception as exc:
        return JSONResponse(
            status_code=200,
            content={
                "status": "REVIEW",
                "details": [f"Pre-download validation encountered an error: {exc}"],
            },
        )

    return {"status": result.status, "details": result.details}