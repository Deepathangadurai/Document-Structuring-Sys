import json
import re
import time
from pathlib import Path
from typing import Any, cast
from uuid import uuid4
from sqlalchemy.orm import Session
from app.db.models import Template
from app.core.config import settings
from app.services.schema_inference import infer_schema_sections_with_page_count, get_document_sections_for_display

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
                    "document_sections", "text_preview",
                ):
                    if not schema.get(computed_key) and existing_schema.get(computed_key):
                        merged_schema[computed_key] = existing_schema[computed_key]
                if merged_schema != existing_schema:
                    setattr(template, "schema", merged_schema)
                    updated = True
                if getattr(template, "structure_locked") != structure_locked_val:
                    setattr(template, "structure_locked", structure_locked_val)
                    updated = True
                if updated:
                    self.db.add(template)
                seen_template_ids.add(template_id)
            else:
                # A template folder that's never been seen before. Don't
                # trust schema.json's (often placeholder) field list or
                # auto-activate it - run the same real-document extraction
                # used for uploads and drop it into Pending Review so a
                # human validates it before it can be used by a project.
                source_path = self._find_source_document(child, file_name_val)
                sections = schema.get("sections", [])
                text_preview = None
                page_count = int(schema.get("page_count") or 1)
                preview_html = schema.get("preview_html") or ""
                page_images: list[str] = schema.get("page_images", []) or []
                page_html: list[str] = schema.get("page_html", []) or []
                document_sections = schema.get("document_sections", [])
                if source_path is not None:
                    try:
                        images_output_dir = self.pending_storage_path / f"{template_id}" / "pages"
                        sections, text_preview, page_count, preview_html, page_images, page_html = infer_schema_sections_with_page_count(
                            source_path, images_output_dir
                        )
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
            sections, text_preview, page_count, preview_html, page_images, page_html = infer_schema_sections_with_page_count(destination, images_output_dir)
            print(f"[template_service] create_pending_template: parsed OK - {page_count} pages, {len(page_images)} page images, {len(page_html)} page html chunks, {len(sections)} sections", flush=True)
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
            setattr(template, "template_id", final_id)
            schema_data["template_id"] = final_id
            setattr(template, "schema", schema_data)
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