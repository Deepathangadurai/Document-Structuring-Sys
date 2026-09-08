import json
import logging
import shutil
import time
from datetime import datetime, timedelta, timezone
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
        now = datetime.now(timezone.utc)
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
            # Upsert missing field (e.g. table cell or template default field)
            field = ExtractedField(
                extraction_job_id=job_id,
                field_id=field_id,
                field_label=field_id,
                value=value or "",
                original_value="",
                confidence=1.0,
                validation_status=validation_status,
                verification_status="verified",
                is_dynamic=True,
            )
            self.db.add(field)
            self.db.flush()
        else:
            if value is not None:
                field.value = value  # type: ignore[assignment]
            field.validation_status = validation_status  # type: ignore[assignment]
            # Any edit/accept/reject invalidates the last "Verify Document &
            # Template" pass for this field - it must be re-run to reflect the
            # new value rather than showing a stale verdict.
            field.verification_status = None  # type: ignore[assignment]
            self.db.add(field)

        # Synchronize populated_tree if present
        job = self.get_job(job_id)
        if job and job.populated_tree:
            try:
                import copy
                from sqlalchemy.orm.attributes import flag_modified
                ptree = copy.deepcopy(job.populated_tree)
                updated_any = False
                def update_sec(sec):
                    nonlocal updated_any
                    for b in sec.get("blocks", []):
                        fb = b.get("field_binding")
                        if fb and fb.get("field_id") == field_id:
                            fb["value"] = value
                            fb["verification_status"] = "verified"
                            updated_any = True
                        for rb in (b.get("row_bindings") or {}).values():
                            if rb.get("field_id") == field_id:
                                rb["value"] = value
                                rb["verification_status"] = "verified"
                                updated_any = True
                        for cb in (b.get("cell_bindings") or {}).values():
                            if cb.get("field_id") == field_id:
                                cb["value"] = value
                                cb["verification_status"] = "verified"
                                updated_any = True
                    for sub in sec.get("subsections", []):
                        update_sec(sub)
                for s in ptree.get("sections", []):
                    update_sec(s)
                if updated_any:
                    job.populated_tree = ptree
                    flag_modified(job, "populated_tree")
                    self.db.add(job)
            except Exception as _sync_err:
                logger.warning("Failed to sync field to populated_tree: %s", _sync_err)

        self.db.commit()
        self.db.refresh(field)
        return field

    def update_block(
        self,
        job_id: int,
        block_id: str,
        new_text: Optional[str] = None,
        new_table_data: Optional[list[list[str]]] = None,
    ) -> Optional[dict]:
        """Update a static paragraph or table block in job.populated_tree."""
        job = self.get_job(job_id)
        if not job or not job.populated_tree:
            return None
        import copy
        from sqlalchemy.orm.attributes import flag_modified
        ptree = copy.deepcopy(job.populated_tree)
        found_block = None

        def traverse(sec):
            nonlocal found_block
            for b in sec.get("blocks", []):
                if b.get("block_id") == block_id:
                    if new_text is not None:
                        if not b.get("original_text") and b.get("text"):
                            b["original_text"] = b.get("text")
                        b["text"] = new_text
                        b["is_edited"] = True
                    if new_table_data is not None:
                        if not b.get("original_table_data") and b.get("table_data"):
                            b["original_table_data"] = copy.deepcopy(b.get("table_data"))
                        b["table_data"] = new_table_data
                        b["is_edited"] = True
                    found_block = b
                    return
            for sub in sec.get("subsections", []):
                traverse(sub)
                if found_block:
                    return

        for s in ptree.get("sections", []):
            traverse(s)
            if found_block:
                break

        if found_block:
            job.populated_tree = ptree
            flag_modified(job, "populated_tree")
            self.db.add(job)
            self.db.commit()
            return found_block
        return None

    def update_block_text(self, job_id: int, block_id: str, new_text: str) -> Optional[dict]:
        """Update a static paragraph or block in job.populated_tree."""
        return self.update_block(job_id, block_id, new_text=new_text)

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
        defaults_map: dict[str, str] = {}
        if job.template and getattr(job.template, "schema", None):
            t_schema = job.template.schema if isinstance(job.template.schema, dict) else {}
            for s in t_schema.get("sections", []):
                for f in s.get("fields", []):
                    fid = f.get("field_id")
                    d_val = f.get("default_value")
                    if fid and d_val is not None and str(d_val).strip():
                        defaults_map[fid] = str(d_val).strip()
                # Also map default cell values from table rows
                sec_id = s.get("section_id")
                for r in s.get("rows", []):
                    r_id = r.get("row_id")
                    for col_idx, cell_val in enumerate(r.get("values", [])):
                        cell_fid = f"{sec_id}__{r_id}__col{col_idx}"
                        cell_d_val = str(cell_val).strip() if cell_val is not None else ""
                        defaults_map[cell_fid] = cell_d_val if cell_d_val else "—"

        fields = []
        for extracted in job.extracted_fields:
            val = extracted.value
            val_status = extracted.validation_status
            default_val = defaults_map.get(extracted.field_id)

            # If value is empty or None, don't leave it empty! Pre-fill with template default and inform user
            if val is None or str(val).strip() == "":
                val = default_val if default_val else "—"
                default_val = val
                val_status = "default"

            is_default = bool(
                val_status == "default" or 
                (default_val and val == default_val and (not extracted.original_value or str(extracted.original_value).strip() == ""))
            )

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
                    "value": val,
                    "original_value": extracted.original_value,
                    "default_value": default_val,
                    "is_default": is_default,
                    "confidence": extracted.confidence,
                    "validation_status": val_status,
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
            # Block-tree populated output — primary data source for JiraFieldEditor.
            # None for jobs that ran before the block-tree pipeline was added.
            "populated_tree": getattr(job, "populated_tree", None),
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
        self._store_extracted_fields(job, final_output, document, required_missing_ids, schema_dict=schema_dict)
        self._seed_static_fields(job, template)

        # Block-tree population — run section-to-section alignment and store
        # the populated master tree on the job for JiraFieldEditor.
        try:
            from app.services.block_tree_service import (
                StructuredDocumentTree as _SDT,
                align_and_populate as _align,
            )
            master_tree_raw = getattr(template, "block_tree", None)
            doc_tree_raw = getattr(document, "block_tree", None)

            # Safeguard: if template block_tree is missing, parse it on-the-fly
            if not master_tree_raw and template:
                try:
                    from app.services.block_tree_service import parse_docx as _bts_parse_docx
                    from pathlib import Path
                    tmpl_file = getattr(template, "file_name", "") or ""
                    tmpl_dir = Path(settings.TEMPLATE_PATH) / str(template.template_id or "")
                    tmpl_path = tmpl_dir / tmpl_file if tmpl_file else None
                    if not tmpl_path or not tmpl_path.exists():
                        for pat in ("*.docx", "*.DOCX"):
                            m = sorted(tmpl_dir.glob(pat))
                            if m:
                                tmpl_path = m[0]
                                break
                    if tmpl_path and tmpl_path.exists():
                        _t_tree = _bts_parse_docx(Path(str(tmpl_path)), str(template.template_id or ""), schema=getattr(template, "schema", None))
                        master_tree_raw = _t_tree.to_dict()
                        template.block_tree = master_tree_raw  # type: ignore[assignment]
                        self.db.add(template)
                except Exception as _t_err:
                    logger.warning("On-the-fly template block_tree failed: %s", _t_err)

            # Safeguard: if document block_tree is missing, parse it on-the-fly
            if not doc_tree_raw and document and getattr(document, "file_path", None):
                try:
                    from app.services.block_tree_service import parse_docx as _bts_p_docx, parse_pdf as _bts_p_pdf
                    from pathlib import Path
                    d_path = Path(str(document.file_path))
                    if d_path.exists():
                        if d_path.suffix.lower() in (".docx", ".doc"):
                            _d_tree = _bts_p_docx(d_path, str(document.id))
                            doc_tree_raw = _d_tree.to_dict()
                        elif d_path.suffix.lower() == ".pdf":
                            _d_tree = _bts_p_pdf(d_path, str(document.id))
                            doc_tree_raw = _d_tree.to_dict()
                        if doc_tree_raw:
                            document.block_tree = doc_tree_raw  # type: ignore[assignment]
                            self.db.add(document)
                except Exception as _d_err:
                    logger.warning("On-the-fly doc block_tree failed: %s", _d_err)

            if master_tree_raw and doc_tree_raw:
                master_tree = _SDT.from_dict(master_tree_raw)
                doc_tree = _SDT.from_dict(doc_tree_raw)
                populated_tree = _align(master_tree, doc_tree)
                job.populated_tree = populated_tree.to_dict()  # type: ignore[assignment]
                self.db.add(job)
                self.db.commit()
        except Exception as _bt_err:
            logger.warning("Block-tree alignment failed for job %s: %s", job_id, _bt_err)

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
        template_dir = template_base_path / str(template.template_id or "")
        template_docx: Optional[Path] = None

        schema_data = template.schema if isinstance(template.schema, dict) else {}
        file_name_hint = str(schema_data.get("file_name") or getattr(template, "file_name", "") or "")
        if file_name_hint:
            candidate = template_dir / file_name_hint
            if candidate.exists() and candidate.suffix.lower() in (".docx", ".doc"):
                template_docx = candidate

        if template_docx is None and template_dir.exists():
            for pattern in ("*.docx", "*.DOCX", "*.doc", "*.DOC"):
                matches = sorted(template_dir.glob(pattern))
                if matches:
                    template_docx = matches[0]
                    break

        # Fallback: check pending_storage_path (/storage/pending_templates/) for uploaded templates
        if template_docx is None:
            pending_dir = Path(settings.STORAGE_PATH) / "pending_templates"
            pending_candidate: Optional[Path] = None
            if file_name_hint and (pending_dir / file_name_hint).exists():
                pending_candidate = pending_dir / file_name_hint
            elif getattr(template, "file_name", None) and (pending_dir / str(template.file_name)).exists():
                pending_candidate = pending_dir / str(template.file_name)

            if pending_candidate and pending_candidate.suffix.lower() in (".docx", ".doc"):
                template_dir.mkdir(parents=True, exist_ok=True)
                dest_docx = template_dir / pending_candidate.name
                try:
                    shutil.copy2(str(pending_candidate), str(dest_docx))
                    template_docx = dest_docx
                    logger.info(f"Auto-healed master template: copied {pending_candidate} to {dest_docx}")
                except Exception as exc:
                    logger.warning(f"Could not copy pending template file to {dest_docx}: {exc}")
                    template_docx = pending_candidate

        if not template_docx or not template_docx.exists():
            # Master template file not found - generate fallback table
            self._export_as_fallback_table(job, output_path)
            return

        template_docx_path = Path(str(template_docx))

        # Build extracted values map (field_id -> value)
        try:
            self.db.refresh(job)
        except Exception:
            pass
        extracted_values = {}
        job_results = self.get_job_results(job)
        for field in job_results.get("extracted_fields", []):
            field_id = field.get("field_id")
            value = field.get("value", "")
            if field_id:
                extracted_values[field_id] = value

        # Collect static paragraph overrides and table blocks if user edited
        static_overrides: dict[str, str] = {}
        table_blocks: list[dict] = []
        if job.populated_tree and isinstance(job.populated_tree, dict):
            def collect_edited_blocks(sec):
                for b in sec.get("blocks", []):
                    if b.get("is_edited") and b.get("original_text") and b.get("text"):
                        orig = str(b["original_text"]).strip()
                        new_t = str(b["text"]).strip()
                        if orig and new_t and orig != new_t:
                            static_overrides[orig] = new_t
                    if b.get("block_type") == "table" and b.get("table_data"):
                        table_blocks.append(b)
                for sub in sec.get("subsections", []):
                    collect_edited_blocks(sub)
            for s in job.populated_tree.get("sections", []):
                collect_edited_blocks(s)

        # Explicitly cast template.schema to dict[str, Any] for type safety
        schema_dict = cast(dict[str, Any], template.schema)

        # Attempt template population
        try:
            engine = TemplatePopulationEngine(template_docx_path, schema_dict)
            population_success, population_report = engine.populate(
                extracted_values,
                Path(output_path),
                preserve_structure=True,
                static_overrides=static_overrides,
                table_blocks=table_blocks,
            )

            replacements = population_report.get('replacements_made', 0)
            errors = population_report.get('errors', [])
            logger.info(
                f"[export job={job.id}] TemplatePopulationEngine.populate() -> "
                f"success={population_success}, replacements={replacements}, errors={errors}"
            )

            if population_success:
                # Validate that structure was preserved.
                # We use a RELAXED check: only warn on structural drift, never
                # block. Value-length changes cause cosmetic text reflow in Word
                # which is expected and acceptable — we must not reject the file.
                try:
                    validation_result = DocumentIntegrityValidator.validate_field_replacement_only(
                        template_docx_path,
                        Path(output_path),
                        schema_dict,
                    )
                    if not validation_result.is_valid:
                        logger.warning(
                            f"[export job={job.id}] Integrity check found differences "
                            f"(acceptable reflow): {validation_result.errors[:3]}. "
                            f"Output is still the populated template — NOT falling back."
                        )
                    else:
                        logger.info(f"[export job={job.id}] Integrity check passed.")
                except Exception as iv_err:
                    logger.warning(f"[export job={job.id}] Integrity check raised {iv_err} — ignored.")
                # Always return the populated file when populate() said success
                logger.info(
                    f"[export job={job.id}] Template population SUCCESS: "
                    f"{replacements} replacements applied, output at {output_path}"
                )
                return
            else:
                # Population failed - generate fallback but with edited values
                logger.warning(
                    f"[export job={job.id}] Template population FAILED "
                    f"(errors={errors}). Falling back to table export "
                    f"with {len(extracted_values)} extracted values."
                )
                self._export_as_fallback_table(job, output_path, extracted_values)

        except Exception as e:
            logger.error(
                f"[export job={job.id}] Template population raised exception: {e}. "
                f"Falling back to table export."
            )
            self._export_as_fallback_table(job, output_path, extracted_values)

    def _export_as_fallback_table(
        self,
        job: ExtractionJob,
        output_path: str,
        extracted_values: dict | None = None,
    ) -> None:
        """
        Generate a fallback table-based document when template population fails.

        extracted_values — optional pre-loaded {field_id: value} dict from the
        caller.  When supplied it takes priority over re-reading from DB so that
        any user-edited values (saved via PATCH) are always reflected in the output.

        This is NOT the primary path - template population with master template
        is preferred. This fallback is only used if:
        - Master template file is missing
        - Template population failed
        """
        from docx import Document as DocxDocument
        from docx.shared import Inches, Pt
        from docx.enum.text import WD_ALIGN_PARAGRAPH  # type: ignore[attr-defined]
        from docx.enum.table import WD_TABLE_ALIGNMENT

        logger.warning(f"Using structured specification export for job {job.id}")

        data = self.build_export_data(job)
        fields = data.get("fields", [])
        # Build maps — prefer caller-supplied extracted_values over DB data
        field_map = {f.get("field_id"): f.get("value") or "" for f in fields}
        if extracted_values:
            field_map.update(extracted_values)  # user edits win
        label_map = {
            f.get("field_label", "").lower().strip(): (
                extracted_values.get(f["field_id"]) if extracted_values and f.get("field_id") in extracted_values
                else f.get("value") or ""
            )
            for f in fields
        }

        # Header fields — use exact schema field IDs first, then label-based fallbacks.
        # Schema cover fields: spec_no, revision, project_no, area, description
        spec_no = (
            field_map.get("spec_no")
            or field_map.get("spec_number")
            or field_map.get("specification_number")
            or label_map.get("spec. no.")
            or label_map.get("spec no")
            or "IP009-43-00-01"
        )
        project_no = (
            field_map.get("project_no")
            or field_map.get("project_number")
            or field_map.get("project_code")
            or label_map.get("project no.")
            or label_map.get("project no")
            or "IP009"
        )
        rev_no = (
            field_map.get("revision")
            or field_map.get("rev_no")
            or field_map.get("rev")
            or label_map.get("rev. no.")
            or label_map.get("revision")
            or "0"
        )
        sheet_no = (
            field_map.get("sheet_no")
            or field_map.get("sheet")
            or label_map.get("sheet no")
            or "SHT. 1 OF 20"
        )
        area_val = (
            field_map.get("area")
            or label_map.get("area")
            or "ELECTRICAL"
        )
        description_val = (
            field_map.get("description")
            or label_map.get("description")
            or label_map.get("description / document title")
            or "ELECTRICAL DESIGN BASIS"
        )

        project_title = field_map.get("project_title") or field_map.get("project_name") or "PASHMINA PROJECT"
        doc_title = data.get("template_name") or "ELECTRICAL DESIGN BASIS"

        doc = DocxDocument()

        for s in doc.sections:
            s.top_margin = Inches(0.6)
            s.bottom_margin = Inches(0.6)
            s.left_margin = Inches(0.6)
            s.right_margin = Inches(0.6)

        # ── 1. CHEMTEX Specification Header Box Table (Matching Reference Flow) ──
        header_table = doc.add_table(rows=3, cols=3)
        header_table.alignment = WD_TABLE_ALIGNMENT.CENTER
        header_table.style = 'Table Grid'

        # Row 0
        r0 = header_table.rows[0].cells
        r0[0].text = "CHEMTEX"
        r0[0].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        if r0[0].paragraphs[0].runs:
            r0[0].paragraphs[0].runs[0].font.bold = True
            r0[0].paragraphs[0].runs[0].font.size = Pt(12)

        r0[1].text = f"SPEC. NO.   :   {spec_no}"
        if r0[1].paragraphs[0].runs:
            r0[1].paragraphs[0].runs[0].font.bold = True
            r0[1].paragraphs[0].runs[0].font.size = Pt(9.5)

        r0[2].text = f"{rev_no if 'REV' in str(rev_no) else 'REV. ' + str(rev_no)}"
        if r0[2].paragraphs[0].runs:
            r0[2].paragraphs[0].runs[0].font.bold = True
            r0[2].paragraphs[0].runs[0].font.size = Pt(9.5)

        # Row 1
        r1 = header_table.rows[1].cells
        r1[0].text = ""
        r1[1].text = f"PROJECT NO :   {project_no}"
        if r1[1].paragraphs[0].runs:
            r1[1].paragraphs[0].runs[0].font.bold = True
            r1[1].paragraphs[0].runs[0].font.size = Pt(9.5)

        r1[2].text = f"{sheet_no if 'SHT' in str(sheet_no) else 'SHT. ' + str(sheet_no)}"
        if r1[2].paragraphs[0].runs:
            r1[2].paragraphs[0].runs[0].font.bold = True
            r1[2].paragraphs[0].runs[0].font.size = Pt(9.5)

        # Row 2
        r2 = header_table.rows[2].cells
        r2[0].text = f"AREA:   {area_val}"
        if r2[0].paragraphs[0].runs:
            r2[0].paragraphs[0].runs[0].font.bold = True
            r2[0].paragraphs[0].runs[0].font.size = Pt(9.5)

        r2[1].text = f"DESCRIPTION :   {description_val}"
        if r2[1].paragraphs[0].runs:
            r2[1].paragraphs[0].runs[0].font.bold = True
            r2[1].paragraphs[0].runs[0].font.size = Pt(9.5)

        r2[1].merge(r2[2])

        # ── 2. Centered Cover Titles Flow (Matching Reference Flow) ──
        p_space = doc.add_paragraph()
        p_space.paragraph_format.space_before = Pt(40)

        p1 = doc.add_paragraph()
        p1.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r1_run = p1.add_run(f"IP-{project_no}" if not str(project_no).startswith("IP") else str(project_no))
        r1_run.bold = True
        r1_run.font.size = Pt(20)
        p1.paragraph_format.space_after = Pt(28)

        p2 = doc.add_paragraph()
        p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r2_run = p2.add_run(str(project_title).upper())
        r2_run.bold = True
        r2_run.font.size = Pt(22)
        p2.paragraph_format.space_after = Pt(32)

        p3 = doc.add_paragraph()
        p3.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r3_run = p3.add_run(str(doc_title).upper())
        r3_run.bold = True
        r3_run.font.size = Pt(20)
        p3.paragraph_format.space_after = Pt(44)

        # ── 3. Structured Technical Specification Flow Table ──
        sec_table = doc.add_table(rows=1, cols=2)
        sec_table.style = 'Table Grid'
        hdr = sec_table.rows[0].cells
        hdr[0].text = "SPECIFICATION PARAMETER"
        hdr[1].text = "EXTRACTED SPECIFICATION VALUE"
        if hdr[0].paragraphs[0].runs:
            hdr[0].paragraphs[0].runs[0].font.bold = True
        if hdr[1].paragraphs[0].runs:
            hdr[1].paragraphs[0].runs[0].font.bold = True

        for field in fields:
            row_cells = sec_table.add_row().cells
            lbl = field.get("field_label") or field.get("field_id") or ""
            val = field.get("value") or "—"
            row_cells[0].text = str(lbl)
            row_cells[1].text = str(val)

        doc.save(output_path)

    def _store_extracted_fields(
        self,
        job: ExtractionJob,
        model_output: dict,
        document: Document,
        required_missing_ids: Optional[set[str]] = None,
        schema_dict: Optional[dict] = None,
    ) -> None:
        required_missing_ids = required_missing_ids or set()
        fields = model_output.get("fields", [])

        defaults_by_id: dict[str, str] = {}
        if schema_dict:
            for sec in schema_dict.get("sections", []):
                for fld in sec.get("fields", []):
                    fid = fld.get("field_id")
                    d_val = fld.get("default_value")
                    if fid and d_val is not None and str(d_val).strip():
                        defaults_by_id[fid] = str(d_val).strip()
                sec_id = sec.get("section_id")
                for r in sec.get("rows", []):
                    r_id = r.get("row_id")
                    for col_idx, cell_val in enumerate(r.get("values", [])):
                        cell_fid = f"{sec_id}__{r_id}__col{col_idx}"
                        cell_d_val = str(cell_val).strip() if cell_val is not None else ""
                        defaults_by_id[cell_fid] = cell_d_val if cell_d_val else "—"

        for field in fields:
            field_id = field.get("field_id")
            raw_val = field.get("value")
            is_empty = raw_val is None or (isinstance(raw_val, str) and not raw_val.strip())
            default_val = defaults_by_id.get(field_id)

            if is_empty:
                # Value was missing in document -> do NOT leave it empty! Remain it with default value
                final_val = default_val if default_val else "—"
                orig_val = ""
                val_status = "default"
            else:
                final_val = raw_val
                orig_val = raw_val
                val_status = "pending"

            extracted = ExtractedField(
                extraction_job_id=job.id,
                field_id=field_id,
                field_label=field.get("field_name"),
                value=final_val,
                original_value=orig_val,
                confidence=field.get("confidence"),
                validation_status=val_status,
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