from pathlib import Path
from typing import cast, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.services.document_service import DocumentService
from app.services.extraction_service import ProjectService
from app.db.schemas import DocumentMetadataResponse, PageResponse

router = APIRouter()

@router.post("/projects/{project_id}/documents", response_model=DocumentMetadataResponse)
def upload_document(project_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    project_service = ProjectService(db)
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    document_service = DocumentService(db)
    try:
        document = document_service.save_document(project_id, file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return document_service.to_response(document)

@router.get("/projects/{project_id}/documents", response_model=list[DocumentMetadataResponse])
def list_project_documents(project_id: int, db: Session = Depends(get_db)):
    project_service = ProjectService(db)
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    document_service = DocumentService(db)
    documents = document_service.list_documents(project_id)
    return [document_service.to_response(doc) for doc in documents]

@router.get("/documents/{document_id}/pages", response_model=list[PageResponse])
def list_document_pages(document_id: int, db: Session = Depends(get_db)):
    """All extracted pages for a document, for building a preview pane.
    Previously the only way to read page content was one page at a time,
    and nothing in the frontend called it at all."""
    document_service = DocumentService(db)
    document = document_service.get_document(document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")

    page_count = cast(int, document.page_count) or 0
    pages = []
    for page_number in range(1, page_count + 1):
        page = document_service.get_page(document_id, page_number)
        if not page:
            continue
        pages.append(
            {
                "document_id": document_id,
                "page_number": page_number,
                "text": page.text,
                "has_image": bool(page.image_path),
                "total_pages": document.page_count,
            }
        )
    return pages

@router.get("/documents/{document_id}/pages/{page_number}", response_model=PageResponse)
def get_document_page(document_id: int, page_number: int, db: Session = Depends(get_db)):
    document_service = DocumentService(db)
    document = document_service.get_document(document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")

    page = document_service.get_page(document_id, page_number)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    return {
        "document_id": document_id,
        "page_number": page_number,
        "text": page.text,
        "has_image": bool(page.image_path),
        "total_pages": document.page_count,
    }

@router.get("/documents/{document_id}/pages/{page_number}/image")
def get_document_page_image(document_id: int, page_number: int, db: Session = Depends(get_db)):
    document_service = DocumentService(db)
    document = document_service.get_document(document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")

    page = document_service.get_page(document_id, page_number)
    raw_image_path = cast(Optional[str], page.image_path if page else None)
    if not page or not raw_image_path:
        raise HTTPException(status_code=404, detail="Page image not available")

    image_path = Path(raw_image_path)
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Page image file missing on disk")

    return FileResponse(str(image_path), media_type="image/png")