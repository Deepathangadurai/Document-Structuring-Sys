from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
import os
from app.core.config import settings

DATABASE_URL = os.getenv("DATABASE_URL") or settings.DATABASE_URL

# SQLite requires check_same_thread=False for multi-threaded frameworks like FastAPI
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args, future=True, echo=False)
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

    if not statements:
        return

    with target_engine.begin() as conn:
        for statement in statements:
            conn.execute(text(statement))