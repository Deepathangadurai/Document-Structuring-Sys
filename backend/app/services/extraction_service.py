import json
import logging
import time
from datetime import datetime, timedelta
from typing import Optional, Any, cast
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload
from app.core.config import settings
from app.db.models import Project, Document, DocumentPage, ExtractionJob, ExtractedField, SourceReference, Template
from app.services.model import ModelService, ModelServiceConfigurationError
from app.services.document_service import DocumentService

logger = logging.getLogger(__name__)


def _format_datetime(dt_obj: Any) -> Optional[str]:
    return dt_obj.isoformat() if dt_obj is not None else None


class ProjectService:
    def __init__(self, db: Session):
        self.db = db

    def create_project(self, project_name: str, template: Template) -> Project:
        project = Project(
            project_name=project_name,
            template_id=template.id,
            template_version=template.version,
            status="active",
        )
        self.db.add(project)
        self.db.commit()
        self.db.refresh(project)
        return project

    def list_projects(self, limit: int = 100, offset: int = 0):
        # Eager-load template to avoid N+1 queries
        projects = (
            self.db.query(Project)
            .options(joinedload(Project.template))
            .order_by(Project.created_at.desc())
            .limit(limit)
            .offset(offset)
            .all()
        )
        if not projects:
            return []

        project_ids = [p.id for p in projects]

        query_results = (
            self.db.query(Document.project_id, func.count(Document.id))
            .filter(Document.project_id.in_(project_ids))
            .group_by(Document.project_id)
            .all()
        )
        doc_counts = {project_id: count for project_id, count in query_results}

        # Latest extraction job status per project
        latest_jobs: dict[int, str] = {}
        job_rows = (
            self.db.query(ExtractionJob.project_id, ExtractionJob.status, ExtractionJob.created_at)
            .filter(ExtractionJob.project_id.in_(project_ids))
            .order_by(ExtractionJob.created_at.desc())
            .all()
        )
        for project_id, status, _created_at in job_rows:
            if project_id not in latest_jobs:
                latest_jobs[project_id] = status

        return [
            self._to_response(
                project,
                document_count=doc_counts.get(cast(int, project.id), 0),
                latest_job_status=latest_jobs.get(cast(int, project.id)),
            )
            for project in projects
        ]

    def get_project(self, project_id: int) -> Optional[Project]:
        return (
            self.db.query(Project)
            .options(joinedload(Project.template))
            .filter_by(id=project_id)
            .first()
        )

    def get_document(self, document_id: int) -> Optional[Document]:
        return self.db.query(Document).filter_by(id=document_id).first()

    def _to_response(
        self,
        project: Project,
        document_count: int = 0,
        latest_job_status: Optional[str] = None,
    ) -> dict:
        created_at = getattr(project, "created_at", None)
        updated_at = getattr(project, "updated_at", None)
        return {
            "id": project.id,
            "project_name": project.project_name,
            "template_id": project.template.template_id,
            "template_name": project.template.template_name,
            "template_version": project.template_version,
            "status": project.status,
            "created_at": _format_datetime(created_at) or "",
            "updated_at": _format_datetime(updated_at) or "",
            "document_count": document_count,
            "latest_job_status": latest_job_status,
        }

    def get_project_detail(self, project_id: int) -> Optional[dict]:
        project = self.get_project(project_id)
        if not project:
            return None
        documents = []
        for document in project.documents:
            doc_created_at = getattr(document, "created_at", None)
            documents.append(
                {
                    "id": document.id,
                    "project_id": document.project_id,
                    "original_filename": document.original_filename,
                    "stored_filename": document.stored_filename,
                    "file_type": document.file_type,
                    "file_size": document.file_size,
                    "page_count": document.page_count,
                    "upload_status": document.upload_status,
                    "created_at": _format_datetime(doc_created_at) or "",
                }
            )

        extraction_jobs = []
        for job in project.extraction_jobs:
            job_created_at = getattr(job, "created_at", None)
            job_started_at = getattr(job, "started_at", None)
            job_completed_at = getattr(job, "completed_at", None)
            extraction_jobs.append(
                {
                    "id": job.id,
                    "project_id": job.project_id,
                    "document_id": job.document_id,
                    "template_id": job.template_id,
                    "status": job.status,
                    "progress": job.progress,
                    "current_page": job.current_page,
                    "total_pages": job.total_pages,
                    "error_message": job.error_message,
                    "created_at": _format_datetime(job_created_at),
                    "started_at": _format_datetime(job_started_at),
                    "completed_at": _format_datetime(job_completed_at),
                }
            )

        created_at = getattr(project, "created_at", None)
        updated_at = getattr(project, "updated_at", None)
        return {
            "id": project.id,
            "project_name": project.project_name,
            "template_id": project.template.template_id,
            "template_name": project.template.template_name,
            "template_version": project.template_version,
            "status": project.status,
            "created_at": _format_datetime(created_at) or "",
            "updated_at": _format_datetime(updated_at) or "",
            "documents": documents,
            "extraction_jobs": extraction_jobs,
        }


class DashboardService:
    def __init__(self, db: Session):
        self.db = db

    def get_stats(self) -> dict:
        now = datetime.utcnow()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        week_start = now - timedelta(days=7)

        total_projects = self.db.query(func.count(Project.id)).scalar() or 0
        projects_this_month = (
            self.db.query(func.count(Project.id))
            .filter(Project.created_at >= month_start)
            .scalar()
            or 0
        )

        documents_processed = (
            self.db.query(func.count(Document.id))
            .filter(Document.upload_status == "processed")
            .scalar()
            or 0
        )
        documents_this_week = (
            self.db.query(func.count(Document.id))
            .filter(Document.upload_status == "processed", Document.created_at >= week_start)
            .scalar()
            or 0
        )

        avg_confidence = (
            self.db.query(func.avg(ExtractedField.confidence))
            .filter(ExtractedField.confidence.isnot(None))
            .scalar()
        )
        extraction_accuracy = round(avg_confidence * 100, 1) if avg_confidence is not None else None

        pending_validation = (
            self.db.query(func.count(ExtractedField.id))
            .filter(ExtractedField.validation_status == "pending")
            .scalar()
            or 0
        )

        active_templates = (
            self.db.query(func.count(Template.id)).filter(Template.is_active.is_(True)).scalar() or 0
        )

        return {
            "total_projects": total_projects,
            "projects_created_this_month": projects_this_month,
            "documents_processed": documents_processed,
            "documents_processed_this_week": documents_this_week,
            "extraction_accuracy": extraction_accuracy,
            "pending_validation": pending_validation,
            "active_templates": active_templates,
        }


class ExtractionService:
    def __init__(self, db: Session):
        self.db = db
        # ModelService is intentionally NOT constructed here. It talks to
        # Ollama/Qwen2.5-VL, and this constructor runs on every request that
        # touches an extraction job -- including just checking job status.
        # If the model is unreachable, that must fail the specific job with
        # a clear error (see process_job), not 500 every status check.
        self.document_service = DocumentService(db)

    def create_job(self, project: Project, document: Document) -> ExtractionJob:
        job = ExtractionJob(
            project_id=project.id,
            document_id=document.id,
            template_id=project.template_id,
            status="pending",
            progress=0,
            current_page=0,
            total_pages=document.page_count or 0,
        )
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)
        return job

    def get_job(self, job_id: int) -> Optional[ExtractionJob]:
        return self.db.query(ExtractionJob).filter_by(id=job_id).first()

    def get_field(self, job_id: int, field_id: str) -> Optional[ExtractedField]:
        return (
            self.db.query(ExtractedField)
            .filter_by(extraction_job_id=job_id, field_id=field_id)
            .first()
        )

    def update_field(self, job_id: int, field_id: str, value: Optional[str], validation_status: str) -> Optional[ExtractedField]:
        field = self.get_field(job_id, field_id)
        if not field:
            return None
        if value is not None:
            field.value = value  # type: ignore[assignment]
        field.validation_status = validation_status  # type: ignore[assignment]
        self.db.add(field)
        self.db.commit()
        self.db.refresh(field)
        return field

    def get_job_results(self, job: ExtractionJob) -> dict:
        fields = []
        for extracted in job.extracted_fields:
            sources = [
                {
                    "page_number": source.page_number,
                    "source_text": source.source_text,
                    "confidence": source.confidence,
                    "bounding_box": source.bounding_box,
                }
                for source in extracted.source_references
            ]
            fields.append(
                {
                    "field_id": extracted.field_id,
                    "field_label": extracted.field_label,
                    "value": extracted.value,
                    "confidence": extracted.confidence,
                    "validation_status": extracted.validation_status,
                    "source_references": sources,
                }
            )
        created_at = getattr(job, "created_at", None)
        started_at = getattr(job, "started_at", None)
        completed_at = getattr(job, "completed_at", None)
        return {
            "id": job.id,
            "project_id": job.project_id,
            "document_id": job.document_id,
            "template_id": job.template_id,
            "status": job.status,
            "progress": job.progress,
            "current_page": job.current_page,
            "total_pages": job.total_pages,
            "error_message": job.error_message,
            "created_at": _format_datetime(created_at),
            "started_at": _format_datetime(started_at),
            "completed_at": _format_datetime(completed_at),
            "extracted_fields": fields,
        }

    def process_job(self, job_id: int) -> None:
        job = self.get_job(job_id)
        if not job:
            return

        job.status = "processing"  # type: ignore[assignment]
        job.started_at = datetime.utcnow()  # type: ignore[assignment]
        self.db.add(job)
        self.db.commit()

        doc_id = cast(int, job.document_id)
        document = self.document_service.get_document(doc_id)
        if not document:
            job.status = "failed"  # type: ignore[assignment]
            job.error_message = "Document not found"  # type: ignore[assignment]
            self.db.add(job)
            self.db.commit()
            return

        template = self.db.query(Template).filter_by(id=job.template_id).first()
        if not template:
            job.status = "failed"  # type: ignore[assignment]
            job.error_message = "Template not found"  # type: ignore[assignment]
            self.db.add(job)
            self.db.commit()
            return

        pages = self.db.query(DocumentPage).filter_by(document_id=document.id).order_by(DocumentPage.page_number).all()
        page_chunks = self._chunk_pages(pages, settings.DOCUMENT_CHUNK_SIZE)
        total_chunks = len(page_chunks)
        job.total_pages = len(pages)  # type: ignore[assignment]
        self.db.add(job)
        self.db.commit()

        if not page_chunks:
            job.status = "failed"  # type: ignore[assignment]
            job.error_message = "No document pages available"  # type: ignore[assignment]
            self.db.add(job)
            self.db.commit()
            return

        try:
            model_service = ModelService()
        except ModelServiceConfigurationError as exc:
            job.status = "failed"  # type: ignore[assignment]
            job.error_message = str(exc)  # type: ignore[assignment]
            self.db.add(job)
            self.db.commit()
            return

        if not model_service.is_available():
            job.status = "failed"  # type: ignore[assignment]
            health = model_service.health()
            job.error_message = f"Qwen2.5-VL model unavailable: {health.get('reason') or 'unknown'}"  # type: ignore[assignment]
            self.db.add(job)
            self.db.commit()
            return

        accumulated_fields: dict[str, dict] = {}
        # Copy (not mutate) the stored schema so the master template's actual
        # text content can be passed to the model as grounding context
        # alongside the hand-authored field list, without touching the
        # persisted schema JSON itself.
        schema_dict = dict(cast(dict[Any, Any], template.schema))
        reference_text = cast(Optional[str], getattr(template, "reference_text", None))
        if reference_text:
            schema_dict["reference_document_text"] = reference_text

        for chunk_index, chunk in enumerate(page_chunks, start=1):
            job.current_page = chunk[-1].page_number if chunk else 0  # type: ignore[assignment]
            job.progress = int(chunk_index / total_chunks * 100)  # type: ignore[assignment]
            job.status = "processing"  # type: ignore[assignment]
            self.db.add(job)
            self.db.commit()

            try:
                model_output = model_service.extract(
                    schema_dict,
                    [{"page_number": page.page_number, "text": page.text or ""} for page in chunk]
                )
            except Exception as exc:
                job.status = "failed"  # type: ignore[assignment]
                job.error_message = f"Qwen2.5-VL extraction call failed: {exc}"  # type: ignore[assignment]
                self.db.add(job)
                self.db.commit()
                return

            is_valid, validated_res = self._validate_output(model_output, schema_dict)
            if not is_valid:
                job.status = "failed"  # type: ignore[assignment]
                job.error_message = str(validated_res)  # type: ignore[assignment]
                self.db.add(job)
                self.db.commit()
                return

            validated_data = cast(dict, validated_res)
            for field in validated_data.get("fields", []):
                field_id = field.get("field_id")
                if field_id not in accumulated_fields:
                    accumulated_fields[field_id] = field.copy()
                    continue

                existing = accumulated_fields[field_id]
                if existing.get("value") is None and field.get("value") is not None:
                    accumulated_fields[field_id] = field.copy()
                elif existing.get("value") is None and field.get("source") is None and field.get("source"):
                    accumulated_fields[field_id]["source"] = field.get("source")

            time.sleep(0.5)

        final_output = {
            "template_id": schema_dict.get("template_id"),
            "template_version": schema_dict.get("version"),
            "fields": list(accumulated_fields.values()),
        }
        self._store_extracted_fields(job, final_output, document)

        job.progress = 100  # type: ignore[assignment]
        job.current_page = job.total_pages  # type: ignore[assignment]
        job.status = "completed"  # type: ignore[assignment]
        job.completed_at = datetime.utcnow()  # type: ignore[assignment]
        self.db.add(job)
        self.db.commit()

    def _chunk_pages(self, pages, chunk_size: int):
        if chunk_size <= 0:
            chunk_size = 10
        return [pages[i:i + chunk_size] for i in range(0, len(pages), chunk_size)]

    def _validate_output(self, model_output: dict, schema: dict) -> tuple[bool, dict | str]:
        if not isinstance(model_output, dict):
            return False, "Invalid model output"
        if model_output.get("template_id") != schema.get("template_id"):
            return False, "Template ID mismatch"
        if model_output.get("template_version") != schema.get("version"):
            return False, "Template version mismatch"
        
        fields = model_output.get("fields")
        if not isinstance(fields, list):
            fields = []
            model_output["fields"] = fields

        expected_fields = {}
        for section in schema.get("sections", []):
            for field in section.get("fields", []):
                expected_fields[field["field_id"]] = {
                    "field_label": field["field_label"],
                    "required": field.get("required", False),
                }

        # Auto-fill missing fields in model output with null defaults
        existing_ids = {f.get("field_id") for f in fields if isinstance(f, dict)}
        for field_id, field_info in expected_fields.items():
            if field_id not in existing_ids:
                fields.append({
                    "field_id": field_id,
                    "field_name": field_info["field_label"],
                    "value": None,
                    "confidence": 0.0,
                    "source": None,
                })

        seen_field_ids = set()
        for field in fields:
            if not isinstance(field, dict):
                return False, "Invalid field entry"
            field_id = field.get("field_id")
            if field_id not in expected_fields:
                return False, f"Unknown field: {field_id}"
            if field_id in seen_field_ids:
                return False, f"Duplicate field: {field_id}"
            seen_field_ids.add(field_id)
            field_info = expected_fields[field_id]
            if field.get("field_name") != field_info["field_label"]:
                return False, f"Field name mismatch for {field_id}: expected {field_info['field_label']}"
            if "source" in field and field["source"] is not None and not isinstance(field["source"], dict):
                return False, "Invalid source object"
            source = field.get("source") or {}
            if source.get("page_number") is not None and not isinstance(source.get("page_number"), int):
                return False, "Invalid source page number"
            if source.get("source_text") is not None and not isinstance(source.get("source_text"), str):
                return False, "Invalid source text"
            if source.get("confidence") is not None and not isinstance(source.get("confidence"), (float, int)):
                return False, "Invalid source confidence"

            raw_value = field.get("value")
            normalized_value = raw_value.strip() if isinstance(raw_value, str) else raw_value
            if field_info["required"] and (normalized_value is None or normalized_value == ""):
                return False, (
                    f"Missing required value for '{field_info['field_label']}' (field_id={field_id}). "
                    "This value is required and cannot be left blank; missing values are dangerous for project names/IDs."
                )

        return True, model_output

    def build_export_data(self, job: ExtractionJob) -> dict:
        """Structured-output payload for download (JSON export, and the
        source data for the .docx export). Previously there was no way to
        get extraction results out of the system at all."""
        results = self.get_job_results(job)
        document = self.document_service.get_document(cast(int, job.document_id))
        template = self.db.query(Template).filter_by(id=job.template_id).first()
        return {
            "project_id": results["project_id"],
            "document_id": results["document_id"],
            "document_filename": getattr(document, "original_filename", None) if document else None,
            "template_id": getattr(template, "template_id", None) if template else None,
            "template_name": getattr(template, "template_name", None) if template else None,
            "template_version": getattr(template, "version", None) if template else None,
            "extraction_job_id": results["id"],
            "status": results["status"],
            "completed_at": results["completed_at"],
            "fields": results["extracted_fields"],
        }

    def export_as_docx(self, job: ExtractionJob, output_path: str) -> None:
        """
        Populate the master template with extracted field values.
        
        This uses the TemplatePopulationEngine to ensure:
        1. Master template structure is preserved exactly
        2. Only dynamic field values are replaced
        3. All formatting and layout remain unchanged
        4. The output is 100% identical to the input template (except field values)
        
        Fallback: If template population fails, generates a simple table
        of extracted fields (non-template format).
        """
        from pathlib import Path
        from app.services.template_population_engine import TemplatePopulationEngine
        from app.services.document_integrity_validator import DocumentIntegrityValidator
        from app.core.config import settings
        from docx import Document as DocxDocument

        # Get template and extracted data
        template = self.db.query(Template).filter_by(id=job.template_id).first()
        if not template:
            # No template found - generate fallback table
            self._export_as_fallback_table(job, output_path)
            return

        # Find master template file. The docx is NOT reliably named after
        # the template_id (e.g. templates/specification_01/schema.json has
        # template_id "specification_01" but the actual file is
        # "IP009-43-00-01-0.docx" - named after the source document, not
        # the folder/template_id) - so a naive f"{template_id}.docx" guess
        # silently misses it every time and this always fell through to
        # the generic (non-templated) fallback table export. Look first
        # for the file_name schema.json actually declares, then fall back
        # to whatever single docx/doc file lives in the template's folder,
        # same as TemplateService._find_source_document does for preview.
        template_base_path = Path(settings.TEMPLATE_PATH)
        template_dir = template_base_path / template.template_id
        template_docx = None

        schema_data = template.schema if isinstance(template.schema, dict) else {}
        file_name_hint = schema_data.get("file_name") or ""
        if file_name_hint:
            candidate = template_dir / file_name_hint
            if candidate.exists() and candidate.suffix.lower() in (".docx", ".doc"):
                template_docx = candidate

        if template_docx is None:
            for pattern in ("*.docx", "*.DOCX", "*.doc", "*.DOC"):
                matches = sorted(template_dir.glob(pattern)) if template_dir.exists() else []
                if matches:
                    template_docx = matches[0]
                    break

        if not template_docx or not template_docx.exists():
            # Master template file not found - generate fallback table
            self._export_as_fallback_table(job, output_path)
            return

        # Build extracted values map (field_id -> value)
        extracted_values = {}
        job_results = self.get_job_results(job)
        for field in job_results.get("extracted_fields", []):
            field_id = field.get("field_id")
            value = field.get("value", "")
            if field_id:
                extracted_values[field_id] = value

        # Attempt template population
        try:
            engine = TemplatePopulationEngine(template_docx, template.schema)
            population_success, population_report = engine.populate(
                extracted_values,
                Path(output_path),
                preserve_structure=True,
            )
            
            if population_success:
                # Validate that structure was preserved
                validation_result = DocumentIntegrityValidator.validate_field_replacement_only(
                    template_docx,
                    Path(output_path),
                    template.schema,
                )
                
                if validation_result.is_valid:
                    # Successfully populated with structure preserved
                    logger.info(
                        f"Template population successful for job {job.id}: "
                        f"{population_report['replacements_made']} field replacements"
                    )
                    return
                else:
                    # Structure was changed - this is a critical failure
                    logger.warning(
                        f"Template integrity validation failed for job {job.id}. "
                        f"Generating fallback table."
                    )
                    self._export_as_fallback_table(job, output_path)
                    return
            else:
                # Population failed - generate fallback
                logger.warning(
                    f"Template population failed for job {job.id}: "
                    f"{population_report['errors']}"
                )
                self._export_as_fallback_table(job, output_path)
                
        except Exception as e:
            logger.error(f"Template population error for job {job.id}: {e}")
            self._export_as_fallback_table(job, output_path)

    def _export_as_fallback_table(self, job: ExtractionJob, output_path: str) -> None:
        """
        Generate a fallback table-based document when template population fails.
        
        This is NOT the primary path - template population with master template
        is preferred. This fallback is only used if:
        - Master template file is missing
        - Template population failed
        - Structure validation failed
        """
        from docx import Document as DocxDocument

        logger.warning(
            f"Using fallback table export for job {job.id} "
            "(template population unavailable or failed)"
        )

        data = self.build_export_data(job)
        doc = DocxDocument()
        doc.add_heading(data["template_name"] or "Structured Extraction Output", level=1)
        doc.add_paragraph(f"Source document: {data['document_filename'] or 'n/a'}")
        doc.add_paragraph(f"Template: {data['template_name'] or ''} (v{data['template_version'] or ''})")
        doc.add_paragraph(f"Extraction status: {data['status']}  |  Completed: {data['completed_at'] or 'n/a'}")
        doc.add_paragraph(
            "⚠️ NOTE: This is a fallback export. For the proper populated template, "
            "ensure the master template file is available in /templates/{template_id}/"
        )

        table = doc.add_table(rows=1, cols=4)
        table.style = "Light Grid Accent 1"
        header_cells = table.rows[0].cells
        for i, header in enumerate(["Field", "Value", "Status", "Source page"]):
            header_cells[i].text = header

        for field in data["fields"]:
            row_cells = table.add_row().cells
            row_cells[0].text = field.get("field_label") or field.get("field_id") or ""
            row_cells[1].text = field.get("value") or "—"
            row_cells[2].text = field.get("validation_status") or ""
            sources = field.get("source_references") or []
            page = sources[0].get("page_number") if sources else None
            row_cells[3].text = str(page) if page is not None else "—"

        doc.save(output_path)

    def _store_extracted_fields(self, job: ExtractionJob, model_output: dict, document: Document) -> None:
        fields = model_output.get("fields", [])
        for field in fields:
            extracted = ExtractedField(
                extraction_job_id=job.id,
                field_id=field.get("field_id"),
                field_label=field.get("field_name"),
                value=field.get("value"),
                confidence=field.get("confidence"),
                validation_status="pending",
            )
            self.db.add(extracted)
            self.db.commit()
            self.db.refresh(extracted)
            source = field.get("source") or {}
            reference = SourceReference(
                extracted_field_id=extracted.id,
                document_id=document.id,
                page_number=source.get("page_number"),
                source_text=source.get("source_text"),
                confidence=source.get("confidence"),
                bounding_box=source.get("bounding_box"),
            )
            self.db.add(reference)
        self.db.commit()