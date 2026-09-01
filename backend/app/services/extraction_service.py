import json
import logging
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Any, cast
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload
from app.core.config import settings
from app.db.models import Project, Document, DocumentPage, ExtractionJob, ExtractedField, SourceReference, Template
from app.services.deterministic_extractor import DeterministicExtractor
from app.services.document_service import DocumentService

logger = logging.getLogger(__name__)


def _format_datetime(dt_obj: Any) -> Optional[str]:
    return dt_obj.isoformat() if dt_obj is not None else None


class ProjectService:
    def __init__(self, db: Session):
        self.db = db

    def create_project(self, project_name: str, template: Optional[Template] = None, project_code: Optional[str] = None) -> Project:
        project = Project(
            project_name=project_name,
            project_code=project_code,
            template_id=template.id if template else None,
            template_version=template.version if template else None,
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

    def delete_project(self, project_id: int) -> bool:
        """Delete a project and everything that hangs off it: documents (+
        their page rows and on-disk files), extraction jobs, extracted
        fields, and source references. No relationship here has an ORM or
        DB-level cascade configured (see models.py), so this deletes in
        explicit child-to-parent order rather than relying on one implicit
        cascading DELETE - the FK constraints would otherwise reject
        deleting a Project that still has rows referencing it.

        Every delete below is a bulk query.delete(), including the Project
        row itself, deliberately - not self.db.delete(project). Mixing the
        two matters here: once project.documents is accessed (to collect
        file paths), those Document objects are tracked in the session's
        identity map. self.db.delete(project) on an ORM object triggers
        SQLAlchemy's default relationship handling, which tries to UPDATE
        each tracked child to null out its FK - but those rows were
        already removed by the bulk deletes below (synchronize_session=
        False doesn't update the identity map), so that UPDATE hits zero
        rows and raises StaleDataError. Using query(Project).delete() for
        the parent too avoids ever touching the ORM-tracked children.
        """
        project = self.db.query(Project).filter_by(id=project_id).first()
        if not project:
            return False

        # Snapshot what's needed for on-disk cleanup from plain queries
        # (not the ORM relationship) before anything is deleted, for the
        # same reason described above.
        documents = self.db.query(Document.id, Document.stored_filename).filter_by(project_id=project_id).all()
        document_ids = [d.id for d in documents]
        job_ids = [
            j.id for j in self.db.query(ExtractionJob.id).filter_by(project_id=project_id).all()
        ]

        if job_ids:
            field_ids = [
                f.id for f in
                self.db.query(ExtractedField.id).filter(ExtractedField.extraction_job_id.in_(job_ids)).all()
            ]
            if field_ids:
                self.db.query(SourceReference).filter(
                    SourceReference.extracted_field_id.in_(field_ids)
                ).delete(synchronize_session=False)
            self.db.query(ExtractedField).filter(
                ExtractedField.extraction_job_id.in_(job_ids)
            ).delete(synchronize_session=False)
            self.db.query(ExtractionJob).filter(
                ExtractionJob.id.in_(job_ids)
            ).delete(synchronize_session=False)

        if document_ids:
            self.db.query(DocumentPage).filter(
                DocumentPage.document_id.in_(document_ids)
            ).delete(synchronize_session=False)

        # Files on disk (original upload + rendered page images) are only
        # removed after the DB rows commit successfully below - deleting
        # the DB record but leaving orphaned files is recoverable (disk
        # space wasted), but the reverse (files gone, DB delete fails,
        # project still "exists" pointing at nothing) is not.
        document_service = DocumentService(self.db)
        file_paths_to_remove: list[Path] = []
        for doc_id, stored_filename in documents:
            if stored_filename:
                file_paths_to_remove.append(document_service.originals_path / stored_filename)
            file_paths_to_remove.append(document_service.pages_path / str(doc_id))

        self.db.query(Document).filter(Document.project_id == project_id).delete(synchronize_session=False)
        self.db.query(Project).filter(Project.id == project_id).delete(synchronize_session=False)
        self.db.commit()

        for path in file_paths_to_remove:
            try:
                if path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
                elif path.exists():
                    path.unlink()
            except OSError:
                logger.warning("Could not remove file while deleting project %s: %s", project_id, path)

        return True

    def delete_extraction_job(self, job_id: int) -> bool:
        """Delete a single specification's extraction results from a
        project, without touching the project, its document, or any other
        specification's job - the narrower alternative to delete_project
        for the common case of "I don't need this one template's results
        anymore" (e.g. to free up a template that's otherwise blocked from
        deletion by a project that's still very much in use)."""
        job = self.db.query(ExtractionJob).filter_by(id=job_id).first()
        if not job:
            return False

        field_ids = [
            f.id for f in
            self.db.query(ExtractedField.id).filter(ExtractedField.extraction_job_id == job_id).all()
        ]
        if field_ids:
            self.db.query(SourceReference).filter(
                SourceReference.extracted_field_id.in_(field_ids)
            ).delete(synchronize_session=False)
        self.db.query(ExtractedField).filter(
            ExtractedField.extraction_job_id == job_id
        ).delete(synchronize_session=False)
        self.db.query(ExtractionJob).filter(ExtractionJob.id == job_id).delete(synchronize_session=False)
        self.db.commit()
        return True

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
            "project_code": project.project_code,
            "template_id": project.template.template_id if project.template else None,
            "template_name": project.template.template_name if project.template else None,
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
            job_template = job.template
            extraction_jobs.append(
                {
                    "id": job.id,
                    "project_id": job.project_id,
                    "document_id": job.document_id,
                    "template_id": job.template_id,
                    "template_code": job_template.template_id if job_template else None,
                    "template_name": job_template.template_name if job_template else None,
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
            "project_code": project.project_code,
            "template_id": project.template.template_id if project.template else None,
            "template_name": project.template.template_name if project.template else None,
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

    def create_job(self, project: Project, document: Document, template: Optional[Template] = None) -> ExtractionJob:
        # `template` is the specific matched specification this job is for.
        # Falls back to project.template_id for backward compatibility with
        # the old single-template-per-project flow.
        resolved_template_id = template.id if template else project.template_id
        if resolved_template_id is None:
            raise ValueError("No template specified for this extraction job")
        job = ExtractionJob(
            project_id=project.id,
            document_id=document.id,
            template_id=resolved_template_id,
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
        # Any edit/accept/reject invalidates the last "Verify Document &
        # Template" pass for this field - it must be re-run to reflect the
        # new value rather than showing a stale verdict.
        field.verification_status = None  # type: ignore[assignment]
        self.db.add(field)
        self.db.commit()
        self.db.refresh(field)
        return field

    def store_verification_results(self, job_id: int, results: list[dict]) -> None:
        by_field_id = {r["field_id"]: r for r in results}
        fields = self.db.query(ExtractedField).filter_by(extraction_job_id=job_id).all()
        for field in fields:
            result = by_field_id.get(field.field_id)
            if result:
                field.verification_status = result["status"]  # type: ignore[assignment]
                self.db.add(field)
        self.db.commit()

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
                    "original_value": extracted.original_value,
                    "confidence": extracted.confidence,
                    "validation_status": extracted.validation_status,
                    "verification_status": extracted.verification_status,
                    "is_dynamic": extracted.is_dynamic,
                    "source_references": sources,
                }
            )
        created_at = getattr(job, "created_at", None)
        started_at = getattr(job, "started_at", None)
        completed_at = getattr(job, "completed_at", None)
        job_template = job.template
        return {
            "id": job.id,
            "project_id": job.project_id,
            "document_id": job.document_id,
            "template_id": job.template_id,
            "template_code": job_template.template_id if job_template else None,
            "template_name": job_template.template_name if job_template else None,
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

        job.total_pages = len(pages)  # type: ignore[assignment]
        job.progress = 10  # type: ignore[assignment]
        self.db.add(job)
        self.db.commit()

        if not pages:
            job.status = "failed"  # type: ignore[assignment]
            job.error_message = "No document pages available"  # type: ignore[assignment]
            self.db.add(job)
            self.db.commit()
            return

        schema_dict = dict(cast(dict[Any, Any], template.schema))

        # Build the page list and table_rows_by_page dict for the extractor
        page_dicts = [{"page_number": p.page_number, "text": p.text or ""} for p in pages]
        table_rows_by_page = self._load_table_rows(pages)

        # --- Deterministic extraction (replaces Qwen2.5-VL model call) ------
        # No chunking, no retries, no network I/O.  Completes in milliseconds.
        job.progress = 50  # type: ignore[assignment]
        self.db.add(job)
        self.db.commit()

        extractor = DeterministicExtractor()
        final_output = extractor.extract(schema_dict, page_dicts, table_rows_by_page)
        # ---------------------------------------------------------------------

        required_missing_ids = self._required_missing_field_ids(final_output, schema_dict)
        self._store_extracted_fields(job, final_output, document, required_missing_ids)
        self._seed_static_fields(job, template)

        job.progress = 100  # type: ignore[assignment]
        job.current_page = len(pages)  # type: ignore[assignment]
        job.status = "completed"  # type: ignore[assignment]
        job.completed_at = datetime.utcnow()  # type: ignore[assignment]
        self.db.add(job)
        self.db.commit()

    def _load_table_rows(self, pages: list[DocumentPage]) -> dict[int, list[str]]:
        """
        Reconstruct the table_rows_by_page dict from DocumentPage.text.

        document_service._extract_docx_pages appends table row strings to
        page text, prefixed with '[TABLE ROW] '.  This helper strips that
        prefix and returns them keyed by page number, ready for
        DeterministicExtractor._scan_table_section.
        """
        TABLE_ROW_PREFIX = "[TABLE ROW] "
        result: dict[int, list[str]] = {}
        for page in pages:
            page_num = cast(int, page.page_number)
            text = cast(Optional[str], page.text) or ""
            rows: list[str] = []
            for line in text.splitlines():
                if line.startswith(TABLE_ROW_PREFIX):
                    rows.append(line[len(TABLE_ROW_PREFIX):])
            if rows:
                result[page_num] = rows
        return result

    def _required_missing_field_ids(self, model_output: dict, schema: dict) -> set[str]:
        """Field IDs that are marked required in the schema but still have
        no value (None or blank after stripping) in the final, fully
        accumulated extraction output."""
        required_ids = {
            field["field_id"]
            for section in schema.get("sections", [])
            for field in section.get("fields", [])
            if field.get("required")
        }
        if not required_ids:
            return set()

        by_id = {f.get("field_id"): f for f in model_output.get("fields", []) if isinstance(f, dict)}
        missing: set[str] = set()
        for field_id in required_ids:
            value = by_id.get(field_id, {}).get("value")
            normalized = value.strip() if isinstance(value, str) else value
            if normalized is None or normalized == "":
                missing.add(field_id)
        return missing


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

        # Explicitly cast template.schema to dict[str, Any] for type safety
        schema_dict = cast(dict[str, Any], template.schema)

        # Attempt template population
        try:
            engine = TemplatePopulationEngine(template_docx, schema_dict)
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
                    schema_dict,
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

    def _store_extracted_fields(
        self,
        job: ExtractionJob,
        model_output: dict,
        document: Document,
        required_missing_ids: Optional[set[str]] = None,
    ) -> None:
        required_missing_ids = required_missing_ids or set()
        fields = model_output.get("fields", [])
        for field in fields:
            field_id = field.get("field_id")
            extracted = ExtractedField(
                extraction_job_id=job.id,
                field_id=field_id,
                field_label=field.get("field_name"),
                value=field.get("value"),
                original_value=field.get("value"),
                confidence=field.get("confidence"),
                # Required fields the model couldn't find anywhere in the
                # document are flagged "missing" right away so they stand
                # out in the Accept/Edit/Reject list as needing the user to
                # type in a value by hand - everything else starts
                # "pending" for normal review, same as before.
                validation_status="missing" if field_id in required_missing_ids else "pending",
                is_dynamic=True,
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

    def _seed_static_fields(self, job: ExtractionJob, template: Template) -> None:
        """Give the user something to actually edit for STATIC fields.

        Extraction only ever produces rows for dynamic fields (see
        _store_extracted_fields) - static content had no ExtractedField row
        at all, so the workspace had no way to show it, let alone let the
        user override it, even though the original workflow explicitly
        calls for "Static Content: locked by default, user can override".

        Only fields the schema marks `is_dynamic: false` AND that declare a
        `default_value` are seeded here. A static field with no
        default_value is intentionally left with no row at all - it stays
        genuinely locked, exactly as before, with nothing to accidentally
        blank out. is_dynamic=False on the row is what tells the workspace
        UI and the population engine this came from the template default,
        not from extraction.
        """
        schema = getattr(template, "schema") or {}
        sections = schema.get("sections", [])
        for section in sections:
            for field in section.get("fields", []):
                if field.get("is_dynamic", False):
                    continue
                default_value = field.get("default_value")
                if default_value is None:
                    continue
                field_id = field.get("field_id")
                if not field_id:
                    continue
                already_seeded = (
                    self.db.query(ExtractedField)
                    .filter_by(extraction_job_id=job.id, field_id=field_id)
                    .first()
                )
                if already_seeded:
                    continue
                self.db.add(
                    ExtractedField(
                        extraction_job_id=job.id,
                        field_id=field_id,
                        field_label=field.get("field_label", field_id),
                        value=str(default_value),
                        original_value=str(default_value),
                        confidence=None,
                        # Static defaults are correct until a human changes
                        # them, so they start "verified" rather than
                        # "pending" - there's nothing extracted to review.
                        validation_status="verified",
                        is_dynamic=False,
                    )
                )
        self.db.commit()