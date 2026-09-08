from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
import os
from app.core.config import settings

DATABASE_URL = os.getenv("DATABASE_URL") or settings.DATABASE_URL

# SQLite requires check_same_thread=False for multi-threaded frameworks like FastAPI
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args, future=True, echo=False)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, connection_record):
        """Enable WAL mode so readers don't block on extraction writes.

        Without WAL, SQLite serialises every reader and writer on the same
        journal lock. During a long extraction job (many DB commits, one per
        chunk) every status-poll request, page-load, or any other read blocks
        until the write completes - which is why the UI appeared to freeze
        even for simple GET requests while extraction was running.

        WAL allows concurrent readers at all times. The writer (extraction)
        still serialises against other writers, but that's fine: there's
        typically only one extraction running at a time.

        PRAGMA synchronous=NORMAL is safe with WAL - it only skips the
        extra fsync after each commit that FULL mode adds, which matters
        much more for rotating disks than SSDs.
        """
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

def get_engine():
    return engine

# Dependency for FastAPI endpoints
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def run_startup_migrations(bind_engine=None) -> None:
    """Lightweight, dependency-free migration path.

    Base.metadata.create_all() only creates tables that don't exist yet -
    it never alters an existing table. This project has no Alembic setup,
    so when a column is added to a model (e.g. Template.status /
    Template.source_filename) an existing sqlite/postgres DB needs an
    explicit ALTER TABLE or the app will crash on first query. This runs
    once at startup and is a no-op if the columns already exist.
    """
    from sqlalchemy import inspect, text

    target_engine = bind_engine or engine
    inspector = inspect(target_engine)
    assert inspector is not None  # inspect(Engine) always returns an Inspector
    if "templates" not in inspector.get_table_names():
        return  # table will be created fresh by create_all with the new columns

    existing_columns = {col["name"] for col in inspector.get_columns("templates")}
    statements = []
    if "status" not in existing_columns:
        statements.append("ALTER TABLE templates ADD COLUMN status VARCHAR NOT NULL DEFAULT 'active'")
    if "source_filename" not in existing_columns:
        statements.append("ALTER TABLE templates ADD COLUMN source_filename VARCHAR")
    if "structure_locked" not in existing_columns:
        statements.append("ALTER TABLE templates ADD COLUMN structure_locked BOOLEAN NOT NULL DEFAULT FALSE")
    if "structure_signature" not in existing_columns:
        statements.append("ALTER TABLE templates ADD COLUMN structure_signature JSON")

    if "projects" in inspector.get_table_names():
        project_columns = {col["name"] for col in inspector.get_columns("projects")}
        if "project_code" not in project_columns:
            statements.append("ALTER TABLE projects ADD COLUMN project_code VARCHAR")
        # SQLite can't drop a NOT NULL constraint with ALTER TABLE. Projects
        # created before the multi-specification workflow always have a
        # template_id, so leaving the old NOT NULL in place on an existing
        # DB is harmless - it only matters for brand new databases, which
        # get the nullable column straight from create_all().

    if "extracted_fields" in inspector.get_table_names():
        field_columns = {col["name"] for col in inspector.get_columns("extracted_fields")}
        if "verification_status" not in field_columns:
            statements.append("ALTER TABLE extracted_fields ADD COLUMN verification_status VARCHAR")
        if "original_value" not in field_columns:
            # Backfill existing rows' original_value from their current value
            # so Undo has *something* to restore to for fields extracted
            # before this column existed, even though that "original" may
            # already reflect a prior edit for rows modified before the
            # upgrade - there's no way to recover the true pre-edit value
            # for those older rows.
            statements.append("ALTER TABLE extracted_fields ADD COLUMN original_value TEXT")
            statements.append("UPDATE extracted_fields SET original_value = value WHERE original_value IS NULL")
        if "is_dynamic" not in field_columns:
            # Existing rows all came from extraction (the only source before
            # this column existed), so backfilling them as dynamic=true is
            # correct - static rows are a new concept only created from now on.
            statements.append("ALTER TABLE extracted_fields ADD COLUMN is_dynamic BOOLEAN NOT NULL DEFAULT TRUE")

    # Block-tree columns — added for the block-tree extraction pipeline.
    # templates.block_tree      : canonical tree parsed from master .docx
    # documents.block_tree      : tree parsed from each uploaded document
    # extraction_jobs.populated_tree : master tree clone with extracted values
    if "templates" in inspector.get_table_names():
        tmpl_cols = {col["name"] for col in inspector.get_columns("templates")}
        if "block_tree" not in tmpl_cols:
            statements.append("ALTER TABLE templates ADD COLUMN block_tree JSON")

    if "documents" in inspector.get_table_names():
        doc_cols = {col["name"] for col in inspector.get_columns("documents")}
        if "block_tree" not in doc_cols:
            statements.append("ALTER TABLE documents ADD COLUMN block_tree JSON")

    if "extraction_jobs" in inspector.get_table_names():
        job_cols = {col["name"] for col in inspector.get_columns("extraction_jobs")}
        if "populated_tree" not in job_cols:
            statements.append("ALTER TABLE extraction_jobs ADD COLUMN populated_tree JSON")

    if not statements:
        return

    with target_engine.begin() as conn:
        for statement in statements:
            conn.execute(text(statement))