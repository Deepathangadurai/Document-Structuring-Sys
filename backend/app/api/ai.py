import tempfile
from pathlib import Path
from typing import Any, Optional, List
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.services.ai_transform_service import AITransformService
from app.services.document_export_service import DocumentExportService

router = APIRouter()


class AITransformRequest(BaseModel):
    text: str
    instruction: str
    section_name: Optional[str] = None
    context: Optional[dict[str, Any]] = None


class AITransformResponse(BaseModel):
    model_config = {"protected_namespaces": ()}
    result: str
    applied_instruction: str
    model_used: str


class DocumentExportRequest(BaseModel):
    title: str = "AmperePro Engineering Document"
    subtitle: Optional[str] = "Momentive Performance Materials - Pashmina Project"
    sections: List[dict[str, Any]] = []
    format: str = "pdf"  # "pdf" or "docx" or "json"
    project_meta: Optional[dict[str, Any]] = None


@router.post("/ai/transform", response_model=AITransformResponse)
async def transform_with_ai(payload: AITransformRequest):
    """
    Rovo-like inline AI transformation: takes selected or section text
    and applies instructions like 'make formal', 'highlight keywords',
    'simplify', or custom engineering prompts.
    """
    try:
        res = await AITransformService.transform_text(
            text=payload.text,
            instruction=payload.instruction,
            section_name=payload.section_name,
            context=payload.context,
        )
        return res
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AI transformation failed: {exc}")


@router.post("/documents/export-realtime")
def export_realtime_document(payload: DocumentExportRequest):
    """
    Exports the realtime document containing current edits and sections
    to DOCX or PDF using python-docx and LibreOffice.
    """
    if payload.format.lower() == "json":
        return JSONResponse(
            content={
                "title": payload.title,
                "subtitle": payload.subtitle,
                "project_meta": payload.project_meta,
                "sections": payload.sections,
            },
            headers={"Content-Disposition": f'attachment; filename="document_realtime.json"'},
        )

    tmp_dir = tempfile.mkdtemp()
    docx_path = Path(tmp_dir) / "realtime_document.docx"

    try:
        DocumentExportService.create_docx_from_sections(
            title=payload.title,
            subtitle=payload.subtitle,
            sections=payload.sections,
            output_path=str(docx_path),
            project_meta=payload.project_meta,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to generate DOCX: {exc}")

    if payload.format.lower() == "docx":
        return FileResponse(
            str(docx_path),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=f"{payload.title.replace(' ', '_').lower()}_realtime.docx",
        )

    # Format is PDF
    try:
        pdf_path = DocumentExportService.convert_docx_to_pdf(str(docx_path))
        return FileResponse(
            str(pdf_path),
            media_type="application/pdf",
            filename=f"{payload.title.replace(' ', '_').lower()}_realtime.pdf",
        )
    except Exception as exc:
        # If PDF conversion fails, return the DOCX as fallback with a helpful header
        return FileResponse(
            str(docx_path),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=f"{payload.title.replace(' ', '_').lower()}_realtime.docx",
        )
