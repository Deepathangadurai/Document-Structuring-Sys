import json
import re
import shutil
import time
from pathlib import Path
from typing import Any, cast
from uuid import uuid4
import logging
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from app.db.models import Template, Project, ExtractionJob, ExtractedField, SourceReference

logger = logging.getLogger(__name__)
from app.core.config import settings
from app.services.schema_inference import (
    infer_schema_sections_with_page_count,
    get_document_sections_for_display,
    apply_static_block_edits,
)

# Process-wide cache so we don't re-read every schema.json and hit the DB
# on every single /templates request. Templates change rarely (deploy-time),
# so a short TTL plus an mtime check is enough to stay fresh without paying
# the disk + DB cost on the hot path.
_SYNC_TTL_SECONDS = 30
_last_sync_time: float = 0.0
_last_seen_mtime_signature: tuple | None = None


class TemplateService:
    def __init__(self, db: Session):
        self.db = db
        self.template_base_path = Path(settings.TEMPLATE_PATH)
        # Uploaded-but-not-yet-approved templates live here, separate from
        # /templates (which is scanned by sync_templates() and treated as
        # already-trusted deploy-time masters). Keeping them apart means a
        # pending upload can never accidentally become active just because
        # sync_templates() ran.
        self.pending_storage_path = Path(settings.STORAGE_PATH) / "pending_templates"

    def _to_static_urls(self, paths: list[str]) -> list[str]:
        """Convert absolute on-disk page-image paths into URLs the browser
        can actually fetch (served by the /static mount in main.py, which
        exposes STORAGE_PATH). Storing raw filesystem paths in the API
        response is not something a browser <img src=...> can ever load.
        """
        storage_base = Path(settings.STORAGE_PATH).resolve()
        urls: list[str] = []
        for raw in paths:
            try:
                rel = Path(raw).resolve().relative_to(storage_base)
                urls.append(f"/static/{rel.as_posix()}")
            except ValueError:
                # Not under STORAGE_PATH for some reason - skip rather than
                # return an unservable path.
                continue
        return urls

    def _load_schema_from_directory(self, directory: Path) -> dict[str, Any] | None:
        schema_path = directory / "schema.json"
        if not schema_path.exists():
            return None
        try:
            data = json.loads(schema_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _current_mtime_signature(self) -> tuple:
        if not self.template_base_path.exists():
            return ()
        signature = []
        for child in sorted(self.template_base_path.iterdir()):
            schema_path = child / "schema.json"
            if child.is_dir() and schema_path.exists():
                signature.append((child.name, schema_path.stat().st_mtime))
        return tuple(signature)

    def sync_templates_if_needed(self) -> None:
        """Cheap check used on the hot request path: only re-scan disk and
        touch the DB when the TTL has elapsed AND the schema files actually
        changed on disk. Avoids a full sync (disk read + DB write) on every
        single templates request."""
        global _last_sync_time, _last_seen_mtime_signature
        now = time.monotonic()
        if _last_seen_mtime_signature is not None and (now - _last_sync_time) < _SYNC_TTL_SECONDS:
            return

        signature = self._current_mtime_signature()
        if signature != _last_seen_mtime_signature:
            self.sync_templates()
            _last_seen_mtime_signature = signature
        _last_sync_time = now

    def _find_source_document(self, directory: Path, file_name_hint: str) -> Path | None:
        if file_name_hint:
            candidate = directory / file_name_hint
            if candidate.exists():
                return candidate
        for pattern in ("*.docx", "*.DOCX", "*.doc", "*.DOC"):
            matches = sorted(directory.glob(pattern))
            if matches:
                return matches[0]
        return None

    def sync_templates(self) -> None:
        if not self.template_base_path.exists():
            return

        # Track template IDs processed during this sync run (both existing DB entries and newly added ones)
        seen_template_ids: set[str] = set()

        for child in sorted(self.template_base_path.iterdir()):
            if not child.is_dir():
                continue
            schema = self._load_schema_from_directory(child)
            if not schema:
                continue

            template_id = schema.get("template_id")
            if not template_id or not isinstance(template_id, str):
                continue

            # Skip duplicate template_id entries in the disk directory structure during the same sync cycle
            if template_id in seen_template_ids:
                continue

            version_val = str(schema.get("version") or "1.0")
            template_name_val = str(schema.get("template_name") or template_id)
            description_val = schema.get("description")
            spec_num_val = schema.get("specification_number")
            file_name_val = str(schema.get("file_name") or "")
            is_active_val = bool(schema.get("is_active", True))
            structure_locked_val = bool(schema.get("structure_locked", False))

            template = self.db.query(Template).filter_by(template_id=template_id).first()
            if template:
                updated = False
                if str(getattr(template, "version")) != version_val:
                    setattr(template, "version", version_val)
                    updated = True
                if str(getattr(template, "template_name")) != template_name_val:
                    setattr(template, "template_name", template_name_val)
                    updated = True
                if getattr(template, "description") != description_val:
                    setattr(template, "description", description_val)
                    updated = True
                if getattr(template, "specification_number") != spec_num_val:
                    setattr(template, "specification_number", spec_num_val)
                    updated = True
                if str(getattr(template, "file_name")) != file_name_val:
                    setattr(template, "file_name", file_name_val)
                    updated = True

                # BUG (root cause of tables disappearing from already-synced
                # templates): schema.json on disk is deploy-time seed data
                # and never carries the heavy, computed-at-parse-time keys
                # (page_html with its data-field-id table markup,
                # page_images, preview_html, document_sections,
                # text_preview) - those only ever get produced once, by
                # infer_schema_sections_with_page_count(), either the first
                # time a brand-new template folder is synced (see the
                # `else` branch below) or via the pending-review/finalize
                # flow. This branch used to do a blind
                # `template.schema = schema`, which - since the file schema
                # is missing those keys - overwrote and permanently erased
                # them from the DB on every single resync (every backend
                # restart, since sync runs on a TTL). Once erased, every
                # page for that template silently fell back to plain text
                # rendering with no tables and no editable spans, and there
                # was no way to get them back short of re-uploading. Merge
                # instead: only let the file take precedence for keys it
                # actually declares (real content edits like `sections`
                # should still apply), and keep whatever the DB already
                # computed for anything the file is silent on.
                existing_schema = getattr(template, "schema")
                existing_schema = existing_schema if isinstance(existing_schema, dict) else {}
                merged_schema = {**existing_schema, **schema}
                for computed_key in (
                    "page_html", "page_images", "preview_html",
                    "document_sections", "text_preview", "static_blocks",
                ):
                    if not schema.get(computed_key) and existing_schema.get(computed_key):
                        merged_schema[computed_key] = existing_schema[computed_key]
                if merged_schema != existing_schema:
                    setattr(template, "schema", merged_schema)
                    # flag_modified is required because SQLAlchemy's JSON
                    # column tracking may not detect a nested-dict change
                    # even when a new dict object is assigned - without it,
                    # the session silently skips the UPDATE and the new
                    # sections from schema.json never reach the DB.
                    flag_modified(template, "schema")
                    updated = True
                if getattr(template, "structure_locked") != structure_locked_val:
                    setattr(template, "structure_locked", structure_locked_val)
                    updated = True
                if getattr(template, "block_tree", None) is None:
                    source_path = self._find_source_document(child, file_name_val)
                    if source_path is not None and source_path.suffix.lower() in (".docx", ".doc"):
                        try:
                            from app.services.block_tree_service import parse_docx as _parse_docx
                            _bt = _parse_docx(source_path, template_id, schema=merged_schema)
                            setattr(template, "block_tree", _bt.to_dict())
                            flag_modified(template, "block_tree")
                            updated = True
                        except Exception as _bt_err:
                            logger.warning(
                                "BlockTree parse failed for existing template %s: %s", template_id, _bt_err
                            )
                if updated:
                    self.db.add(template)
                seen_template_ids.add(template_id)
            else:
                # A template folder that's never been seen before. Normally
                # don't trust schema.json's (often placeholder) field list -
                # run the same real-document extraction used for uploads and
                # drop it into Pending Review so a human validates it before
                # it can be used by a project.
                #
                # EXCEPT: structure_locked=true is the schema.json author
                # explicitly saying "I've already hand-curated this
                # structure - don't touch it." That flag was being read
                # into structure_locked_val above and stored on the row,
                # but never actually CHECKED anywhere - a write-only flag
                # that did nothing. In practice this meant: re-add a
                # template (e.g. after deleting it, or on a fresh deploy)
                # whose schema.json was hand-edited into a rich, correct
                # section/field structure, and this branch would silently
                # discard all of that and regenerate a naive structure from
                # the raw .doc/.docx instead - which is exactly what "even
                # after updating schema.json, pending shows the old
                # document structure" was. When structure_locked is true,
                # schema.json's own `sections` are kept as the source of
                # truth; only the rendering artifacts (page_html/images/
                # preview) still come from parsing the real document, since
                # those are needed to actually display it.
                source_path = self._find_source_document(child, file_name_val)
                sections = schema.get("sections", [])
                text_preview = None
                page_count = int(schema.get("page_count") or 1)
                preview_html = schema.get("preview_html") or ""
                page_images: list[str] = schema.get("page_images", []) or []
                page_html: list[str] = schema.get("page_html", []) or []
                document_sections = schema.get("document_sections", [])
                static_blocks: list[dict] = schema.get("static_blocks", []) or []
                if source_path is not None:
                    try:
                        images_output_dir = self.pending_storage_path / f"{template_id}" / "pages"
                        (
                            inferred_sections, text_preview, page_count, preview_html,
                            page_images, page_html, static_blocks,
                        ) = infer_schema_sections_with_page_count(source_path, images_output_dir)
                        if not structure_locked_val:
                            sections = inferred_sections
                        document_sections = get_document_sections_for_display(source_path)
                    except Exception:
                        pass  # fall back to whatever schema.json declared

                pending_schema = dict(schema)
                pending_schema["sections"] = sections
                pending_schema["text_preview"] = text_preview
                pending_schema["preview_html"] = preview_html
                pending_schema["page_count"] = page_count
                pending_schema["page_images"] = self._to_static_urls(page_images)
                pending_schema["page_html"] = page_html
                pending_schema["document_sections"] = document_sections
                pending_schema["static_blocks"] = static_blocks

                # Build the canonical block-tree for this template so extraction
                # jobs can run section-to-section alignment without re-parsing
                # the .docx on every run.
                block_tree_dict: dict | None = None
                if source_path is not None and source_path.suffix.lower() in (".docx", ".doc"):
                    try:
                        from app.services.block_tree_service import parse_docx as _parse_docx
                        _bt = _parse_docx(source_path, template_id, schema=dict(schema))
                        block_tree_dict = _bt.to_dict()
                    except Exception as _bt_err:
                        logger.warning(
                            "BlockTree parse failed for %s: %s", template_id, _bt_err
                        )

                template = Template(
                    template_id=template_id,
                    template_name=template_name_val,
                    specification_number=spec_num_val,
                    version=version_val,
                    description=description_val,
                    file_name=file_name_val,
                    source_filename=source_path.name if source_path else file_name_val,
                    schema=pending_schema,
                    is_active=False,
                    status="pending",
                    structure_locked=structure_locked_val,
                    block_tree=block_tree_dict,
                )
                self.db.add(template)
                seen_template_ids.add(template_id)

        self.db.commit()

        global _last_sync_time, _last_seen_mtime_signature
        _last_seen_mtime_signature = self._current_mtime_signature()
        _last_sync_time = time.monotonic()

    def list_templates(self) -> list[dict[str, Any]]:
        self.sync_templates_if_needed()
        templates = (
            self.db.query(Template)
            .filter_by(is_active=True)
            .order_by(Template.template_id)
            .all()
        )
        return [self._to_response(template) for template in templates]

    def get_template(self, template_id: str) -> dict[str, Any] | None:
        self.sync_templates_if_needed()
        template = self.db.query(Template).filter_by(template_id=template_id, is_active=True).first()
        if not template:
            return None
        return self._to_response(template)

    def get_template_model(self, template_id: str) -> Template | None:
        self.sync_templates_if_needed()
        return self.db.query(Template).filter_by(template_id=template_id, is_active=True).first()

    def delete_template(self, template_id: str, force: bool = False) -> None:
        """Hard-delete an active master template. Raises ValueError (the
        API layer turns this into a 400) if any project, or any extraction
        job belonging to a project that's still alive, references it -
        deleting it out from under them would break their template_id
        foreign key and their ability to load at all - UNLESS force=True,
        in which case those blocking jobs (and their fields/source refs)
        are deleted right along with the template. force never touches the
        projects themselves or their other specifications' jobs - only the
        job(s) that were specifically blocking THIS template's deletion.

        Project.template_id is NOT the signal to check for "is this
        template in use" - see its own comment in models.py: it's
        "nullable and mostly vestigial" now that a project is matched to
        templates via detected specifications (one ExtractionJob per
        matched spec) rather than one template up front. A project can
        easily have Project.template_id pointing at nothing while still
        holding a real, live ExtractionJob against this template - so the
        actual signal is entirely "does a live project have a job that
        used this template," not the Project.template_id column.

        SQLite here doesn't enforce foreign keys (no PRAGMA foreign_keys=ON
        in database.py), so an ExtractionJob can exist pointing at a
        project_id that no longer exists - e.g. left behind by a project
        deleted before delete_project's cascade logic existed. Blocking on
        the raw count of jobs referencing this template treated that dead
        history as if it were live data, permanently refusing to delete a
        template that nothing actually depends on anymore. Only jobs whose
        project still exists count toward the block; orphaned jobs (and
        their fields/source references) are cleaned up here regardless of
        force, since nothing would actually break by removing them.

        Deleting only the DB row is not enough: sync_templates() treats
        any template_id folder under TEMPLATE_PATH that ISN'T already in
        the DB as a brand-new upload and re-adds it (as pending) on the
        very next sync cycle. The on-disk folder is removed too so a
        deleted template actually stays deleted instead of quietly
        reappearing within _SYNC_TTL_SECONDS.
        """
        template = self.db.query(Template).filter_by(template_id=template_id).first()
        if not template:
            raise ValueError("Template not found")

        live_project_rows = self.db.query(Project.id, Project.project_name).all()
        live_project_names = {row[0]: row[1] for row in live_project_rows}
        jobs = self.db.query(ExtractionJob).filter_by(template_id=template.id).all()
        live_jobs = [j for j in jobs if j.project_id in live_project_names]
        orphaned_job_ids = [j.id for j in jobs if j.project_id not in live_project_names]

        if live_jobs and not force:
            # Name the actual project(s) rather than just a count, so
            # there's something to act on instead of a number to guess
            # about - go look at THIS project, not "some project somewhere."
            blocking_projects = sorted({live_project_names[j.project_id] for j in live_jobs})
            names = ", ".join(f'"{n}"' for n in blocking_projects)
            raise ValueError(
                f"Cannot delete '{template_id}': {len(live_jobs)} extraction job(s) in project(s) "
                f"{names} still use it. Delete those projects (or just that project's extraction "
                f"results for this template), or force-delete this template to remove those "
                f"job(s)' results along with it."
            )

        jobs_to_clean_up = orphaned_job_ids + ([j.id for j in live_jobs] if force else [])
        if jobs_to_clean_up:
            field_ids = [
                f.id for f in
                self.db.query(ExtractedField.id).filter(ExtractedField.extraction_job_id.in_(jobs_to_clean_up)).all()
            ]
            if field_ids:
                self.db.query(SourceReference).filter(
                    SourceReference.extracted_field_id.in_(field_ids)
                ).delete(synchronize_session=False)
            self.db.query(ExtractedField).filter(
                ExtractedField.extraction_job_id.in_(jobs_to_clean_up)
            ).delete(synchronize_session=False)
            self.db.query(ExtractionJob).filter(
                ExtractionJob.id.in_(jobs_to_clean_up)
            ).delete(synchronize_session=False)

        folder = self.template_base_path / template_id
        self.db.delete(template)
        self.db.commit()

        if folder.exists() and folder.is_dir():
            try:
                shutil.rmtree(folder)
            except OSError:
                pass  # DB row is already gone; a leftover folder will just look like an unsynced upload

        global _last_seen_mtime_signature
        _last_seen_mtime_signature = None  # force a full resync on the next request, not a stale 30s-cached view

    def _to_response(self, template: Template) -> dict[str, Any]:
        schema_attr = getattr(template, "schema")
        schema_data = schema_attr if isinstance(schema_attr, dict) else {}
        return {
            "template_id": cast(str, getattr(template, "template_id")),
            "template_name": cast(str, getattr(template, "template_name")),
            "specification_number": cast(str | None, getattr(template, "specification_number")),
            "version": cast(str, getattr(template, "version")),
            "description": cast(str | None, getattr(template, "description")),
            "sections": schema_data.get("sections", []),
            "page_count": int(schema_data.get("page_count") or 1),
            "preview_html": schema_data.get("preview_html") or "",
            # These were previously omitted here, which meant FastAPI's
            # response_model silently filled them with their empty-list
            # defaults on every response - so the exact-page-image preview
            # and the ordered document-sections view never reached the
            # frontend even though they were computed and stored.
            "page_images": schema_data.get("page_images", []),
            # Soffice-independent per-page HTML fallback (see
            # schema_inference.infer_schema_sections_with_page_count) - the
            # frontend renders this when page_images is empty/unavailable
            # instead of showing a broken preview.
            "page_html": schema_data.get("page_html", []),
            "document_sections": schema_data.get("document_sections", []),
            "static_blocks": schema_data.get("static_blocks", []),
        }

    # ------------------------------------------------------------------
    # Pending templates: upload -> validate/preview -> approve or reject
    # ------------------------------------------------------------------

    def _slugify(self, text: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")
        return slug or "template"

    def _unique_template_id(self, base: str, exclude_id: int | None = None) -> str:
        slug = self._slugify(base)
        candidate = slug
        suffix = 2
        while True:
            query = self.db.query(Template).filter_by(template_id=candidate)
            if exclude_id is not None:
                query = query.filter(Template.id != exclude_id)
            if not query.first():
                return candidate
            candidate = f"{slug}_{suffix}"
            suffix += 1

    def create_pending_template(self, upload_file) -> dict[str, Any]:
        original_filename = upload_file.filename or "uploaded_template"
        extension = Path(original_filename).suffix.lower()
        if extension not in {".doc", ".docx"}:
            raise ValueError("Only .doc or .docx specification files are supported")

        self.pending_storage_path.mkdir(parents=True, exist_ok=True)
        stored_filename = f"{uuid4().hex}{extension}"
        destination = self.pending_storage_path / stored_filename
        with destination.open("wb") as out_file:
            while True:
                chunk = upload_file.file.read(1024 * 1024)
                if not chunk:
                    break
                out_file.write(chunk)

        try:
            # Create directory for page images
            images_output_dir = self.pending_storage_path / stored_filename.replace('.doc', '').replace('.docx', '') / 'pages'
            print(f"[template_service] create_pending_template: parsing {destination} (images -> {images_output_dir})", flush=True)
            sections, text_preview, page_count, preview_html, page_images, page_html, static_blocks = infer_schema_sections_with_page_count(destination, images_output_dir)
            print(f"[template_service] create_pending_template: parsed OK - {page_count} pages, {len(page_images)} page images, {len(page_html)} page html chunks, {len(sections)} sections, {len(static_blocks)} static blocks", flush=True)
            document_sections = get_document_sections_for_display(destination)
        except Exception as exc:
            print(f"[template_service] create_pending_template: FAILED to parse {destination}: {exc!r}", flush=True)
            destination.unlink(missing_ok=True)
            raise ValueError(f"Could not read the document: {exc}") from exc

        display_name = Path(original_filename).stem.replace("_", " ").replace("-", " ").strip().title()
        template_id = self._unique_template_id(display_name or "specification")

        template = Template(
            template_id=template_id,
            template_name=display_name or template_id,
            specification_number=None,
            version="1.0",
            description=f"Draft template parsed from {original_filename}. Review the fields below before approving.",
            file_name=stored_filename,
            source_filename=original_filename,
            schema={
                "template_id": template_id,
                "template_name": display_name or template_id,
                "version": "1.0",
                "sections": sections,
                "text_preview": text_preview,
                "preview_html": preview_html,
                "page_count": page_count,
                "document_sections": document_sections,
                "page_images": self._to_static_urls(page_images),
                "page_html": page_html,
                "static_blocks": static_blocks,
            },
            is_active=False,
            status="pending",
        )
        self.db.add(template)
        self.db.commit()
        self.db.refresh(template)

        return self.to_pending_response(template)

    def list_pending_templates(self) -> list[dict[str, Any]]:
        templates = (
            self.db.query(Template)
            .filter_by(status="pending")
            .order_by(Template.created_at.desc())
            .all()
        )
        return [self.to_pending_response(t) for t in templates]

    def get_pending_template(self, pending_id: int) -> Template | None:
        return self.db.query(Template).filter_by(id=pending_id, status="pending").first()

    def update_pending_template(self, pending_id: int, updates: dict[str, Any]) -> dict[str, Any] | None:
        template = self.get_pending_template(pending_id)
        if not template:
            return None

        schema_attr = getattr(template, "schema")
        schema_data = dict(schema_attr) if isinstance(schema_attr, dict) else {}

        if "template_name" in updates and updates["template_name"]:
            setattr(template, "template_name", updates["template_name"])
            schema_data["template_name"] = updates["template_name"]
        if "description" in updates:
            setattr(template, "description", updates["description"])
        if "specification_number" in updates:
            setattr(template, "specification_number", updates["specification_number"])
        if "sections" in updates and updates["sections"] is not None:
            schema_data["sections"] = updates["sections"]

        if "static_blocks" in updates and updates["static_blocks"] is not None:
            incoming_blocks = updates["static_blocks"]
            existing_blocks = schema_data.get("static_blocks", []) or []
            existing_by_id = {b.get("block_id"): b for b in existing_blocks if b.get("block_id")}

            # Only paragraph-type blocks whose text actually changed get
            # written into the .docx - table blocks are view-only (see
            # apply_static_block_edits), and unchanged blocks are left
            # alone so we never touch a paragraph the reviewer didn't ask
            # to edit.
            to_write = []
            for incoming in incoming_blocks:
                block_id = incoming.get("block_id")
                original = existing_by_id.get(block_id)
                if not original or original.get("block_type") == "table":
                    continue
                if incoming.get("text", "") == original.get("text", ""):
                    continue
                to_write.append(
                    {
                        "block_id": block_id,
                        "paragraph_index": original.get("paragraph_index"),
                        "text": incoming.get("text", ""),
                    }
                )

            stored_filename = cast(str, getattr(template, "file_name"))
            if to_write and stored_filename:
                doc_path = self.pending_storage_path / stored_filename
                if doc_path.exists():
                    applied_ids = apply_static_block_edits(doc_path, to_write)
                    applied_text = {e["block_id"]: e["text"] for e in to_write if e["block_id"] in applied_ids}
                    for block in existing_blocks:
                        if block.get("block_id") in applied_text:
                            block["text"] = applied_text[block["block_id"]]

                    if applied_ids:
                        # The .docx text changed - refresh the rendered
                        # preview byproducts (page_html/page_images/etc.)
                        # from the now-edited file, but only those. Never
                        # let this refresh overwrite `sections` or
                        # `static_blocks`, since both may already carry
                        # edits (renamed fields, removed blocks from a
                        # "promote to dynamic" action) that a fresh
                        # re-parse would otherwise discard - same
                        # selective-merge principle sync_templates() uses.
                        try:
                            images_output_dir = self.pending_storage_path / stored_filename.replace('.doc', '').replace('.docx', '') / 'pages'
                            _, refreshed_preview, refreshed_count, refreshed_html, refreshed_images, refreshed_page_html, _ = infer_schema_sections_with_page_count(
                                doc_path, images_output_dir
                            )
                            schema_data["text_preview"] = refreshed_preview
                            schema_data["page_count"] = refreshed_count
                            schema_data["preview_html"] = refreshed_html
                            schema_data["page_images"] = self._to_static_urls(refreshed_images)
                            schema_data["page_html"] = refreshed_page_html
                        except Exception:
                            pass  # keep the previous preview rather than fail the whole save

            # The incoming list is the frontend's full current set (edits
            # AND removals from "promote to dynamic field") - persist it
            # as-is so a promoted block no longer shows up as static next
            # load. Any table-block text edits sent alongside are dropped
            # here (never applied above), so they can't silently diverge
            # from what's actually in the .docx.
            for incoming in incoming_blocks:
                original = existing_by_id.get(incoming.get("block_id"))
                if original and original.get("block_type") == "table":
                    incoming["text"] = original.get("text", "")
            schema_data["static_blocks"] = incoming_blocks

        setattr(template, "schema", schema_data)
        self.db.add(template)
        self.db.commit()
        self.db.refresh(template)
        return self.to_pending_response(template)

    def approve_pending_template(self, pending_id: int) -> dict[str, Any]:
        template = self.get_pending_template(pending_id)
        if not template:
            raise ValueError("Pending template not found")

        schema_attr = getattr(template, "schema")
        schema_data = schema_attr if isinstance(schema_attr, dict) else {}
        sections = schema_data.get("sections", [])
        total_fields = sum(len(s.get("fields", [])) for s in sections)
        if total_fields == 0:
            raise ValueError("Add at least one field before approving this template")

        current_template_id = cast(str, getattr(template, "template_id"))
        # Deploy-time templates (dropped into /templates/<template_id>/ and
        # picked up by sync_templates()) already have a template_id that IS
        # their on-disk folder name - export/population later looks the
        # master .docx up via `template_base_path / template.template_id`.
        # Re-slugging template_id from a (possibly just-edited) display
        # name would silently break that lookup for every one of the 13
        # master templates the moment someone renames one to its real spec
        # title. Only re-derive template_id for templates that genuinely
        # have no matching folder on disk - i.e. ones uploaded through the
        # app's own upload flow, which never had a folder to begin with.
        has_disk_folder = (self.template_base_path / current_template_id).is_dir()
        if not has_disk_folder:
            final_id = self._unique_template_id(cast(str, getattr(template, "template_name")), exclude_id=cast(int, template.id))

            # The uploaded master .docx currently lives in pending_storage_path
            # (storage/pending_templates/{uuid}.docx), not under /templates/.
            # Export (extraction_service.export_as_docx) looks the master file
            # up via `template_base_path / template.template_id`, so without
            # copying the file over now, that lookup always misses and export
            # silently falls back to the generic non-templated table export
            # for every template approved through the upload flow.
            stored_filename = cast(str, getattr(template, "file_name"))
            source_path = self.pending_storage_path / stored_filename if stored_filename else None
            if source_path and source_path.exists():
                target_dir = self.template_base_path / final_id
                target_dir.mkdir(parents=True, exist_ok=True)
                dest_path = target_dir / source_path.name
                shutil.copy2(source_path, dest_path)
                # Record the exact on-disk filename so extraction_service's
                # file_name hint lookup finds it directly (it also has a
                # glob fallback, but this keeps behavior explicit/fast).
                schema_data["file_name"] = dest_path.name
            else:
                # Nothing to copy - export will fall back to the table
                # export and log a warning, same as before this fix.
                print(
                    f"[template_service] approve_pending_template: source file "
                    f"{source_path} not found for template {template.id}; "
                    "master template will be missing after approval",
                    flush=True,
                )

            setattr(template, "template_id", final_id)
            schema_data["template_id"] = final_id
            setattr(template, "schema", schema_data)
            flag_modified(template, "schema")
        setattr(template, "is_active", True)
        setattr(template, "status", "active")
        self.db.add(template)
        self.db.commit()
        self.db.refresh(template)
        return self._to_response(template)

    def reject_pending_template(self, pending_id: int) -> bool:
        template = self.get_pending_template(pending_id)
        if not template:
            return False
        stored_filename = cast(str, getattr(template, "file_name"))
        if stored_filename:
            (self.pending_storage_path / stored_filename).unlink(missing_ok=True)
        self.db.delete(template)
        self.db.commit()
        return True

    def to_pending_response(self, template: Template) -> dict[str, Any]:
        response = self._to_response(template)
        schema_attr = getattr(template, "schema")
        schema_data = schema_attr if isinstance(schema_attr, dict) else {}
        response["id"] = cast(int, getattr(template, "id"))
        response["status"] = cast(str, getattr(template, "status"))
        response["source_filename"] = cast(str | None, getattr(template, "source_filename"))
        response["text_preview"] = schema_data.get("text_preview")
        response["page_count"] = int(schema_data.get("page_count") or 1)
        return response