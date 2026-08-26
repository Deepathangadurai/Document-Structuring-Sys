"""
One-off fix for a template whose DB row was created back when its folder
only had a placeholder schema.json (no real source .docx/.doc yet) and has
since had the real document added.

sync_templates() only runs full structure inference (infer_schema_sections_with_page_count,
which is what discovers tables, multi-page sections, and per-row field IDs)
the FIRST time a template_id is seen in the DB. Once a Template row exists,
every later sync just merges schema.json's declared keys into that row - it
never re-parses a source document that shows up afterward. So a template
that started as a stub stays stuck with the stub's field list forever, even
after the real .docx/.doc lands in its folder.

This script does NOT delete the old Template row (existing Projects and
ExtractionJobs have a NOT-NULL foreign key to it by numeric id - deleting it
would either fail outright or, worse, cascade and destroy job history).
Instead it renames the row's *string* template_id (the column sync_templates
matches schema.json against) so the id in schema.json on disk no longer
matches any existing row. The next sync_templates() call then treats it as
brand new, runs full inference against the real source document, and drops
the result into Pending Review - exactly like a first-time template upload.

Usage (from inside the backend container, where /app is this repo's
backend/ and app.* is importable):

    python scripts/rewire_stale_template.py specification_02

Safe to run multiple times: if the template_id has already been renamed
(no exact match found), it does nothing and says so.
"""
import sys
from datetime import datetime, timezone

sys.path.insert(0, "/app")

from app.db.database import SessionLocal  # noqa: E402
from app.db.models import Template  # noqa: E402
from app.services.template_service import TemplateService  # noqa: E402


def rewire(template_id: str) -> None:
    db = SessionLocal()
    try:
        template = db.query(Template).filter_by(template_id=template_id).first()
        if not template:
            print(f"No Template row with template_id={template_id!r} - nothing to do "
                  f"(already rewired, or it was never synced).")
            return

        old_db_id = template.id
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        legacy_id = f"{template_id}_legacy_{stamp}"

        print(f"Found Template(id={old_db_id}, template_id={template_id!r}, "
              f"name={template.template_name!r}).")
        print(f"Existing Projects/ExtractionJobs keep pointing at this exact row "
              f"(same numeric id={old_db_id}) - only its template_id string changes, "
              f"so nothing about past extraction history is touched.")

        template.template_id = legacy_id  # type: ignore[assignment]
        db.add(template)
        db.commit()
        print(f"Renamed template_id -> {legacy_id!r}. "
              f"'{template_id}' in schema.json on disk is now unclaimed.")

        print("Running sync_templates() now so the real source document gets "
              "parsed immediately, without waiting for a backend restart...")
        TemplateService(db).sync_templates()

        new_template = db.query(Template).filter_by(template_id=template_id).first()
        if new_template:
            sections = (new_template.schema or {}).get("sections", [])
            field_count = sum(len(s.get("fields", [])) for s in sections)
            print(f"New Template(id={new_template.id}, status={new_template.status!r}) "
                  f"created with {field_count} field(s) across {len(sections)} section(s).")
            print("Check it in the Pending Review screen before it can be used by a project.")
        else:
            print("WARNING: sync_templates() didn't create a new row for this template_id. "
                  "Check that the real source document (.docx/.doc) is actually present in "
                  "its templates/<folder>/ directory and that schema.json's file_name matches it.")
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: python {sys.argv[0]} <template_id>")
        print("Example: python scripts/rewire_stale_template.py specification_02")
        sys.exit(1)
    rewire(sys.argv[1])