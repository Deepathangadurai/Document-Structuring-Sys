from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Float, JSON, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.database import Base

class Template(Base):
    __tablename__ = "templates"

    id = Column(Integer, primary_key=True, index=True)
    template_id = Column(String, unique=True, nullable=False, index=True)
    template_name = Column(String, nullable=False)
    specification_number = Column(String, nullable=True)
    version = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    file_name = Column(String, nullable=False)
    schema = Column(JSON, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    # Review workflow for templates uploaded through the app (as opposed to
    # ones dropped into /templates on disk, which are trusted deploy-time
    # assets and stay "active"). "pending" -> awaiting validation/preview,
    # "active" -> approved and usable by projects, "rejected" -> discarded.
    status = Column(String, nullable=False, default="active")
    # Original uploaded file name, kept for the preview/validation screen.
    source_filename = Column(String, nullable=True)
    # When True, template structure (sections and fields) is locked and immutable.
    # Only field values can be edited. Set to True when template is finalized.
    structure_locked = Column(Boolean, default=False, nullable=False)
    # Structure signature: JSON containing page count, table structure, etc.
    # Used to validate that generated documents maintain the same layout as master template
    structure_signature = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    projects = relationship("Project", back_populates="template")

class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    project_name = Column(String, nullable=False)
    # Human-assigned identifier (requirement: "User creates a project with
    # Project ID"). Free-text, not a DB primary key, so it can match
    # whatever numbering scheme the org already uses.
    project_code = Column(String, nullable=True, index=True)
    # A project used to require a template up front. Now a project starts
    # from ONE uploaded document, and specifications (-> templates) are
    # detected from it, so this is nullable and mostly vestigial - kept
    # for backward compatibility with the old single-template flow.
    template_id = Column(Integer, ForeignKey("templates.id"), nullable=True)
    template_version = Column(String, nullable=True)
    status = Column(String, nullable=False, default="draft")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    template = relationship("Template", back_populates="projects")
    documents = relationship("Document", back_populates="project")
    extraction_jobs = relationship("ExtractionJob", back_populates="project")

class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    original_filename = Column(String, nullable=False)
    stored_filename = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    file_type = Column(String, nullable=False)
    file_size = Column(Integer, nullable=False)
    page_count = Column(Integer, default=0, nullable=False)
    upload_status = Column(String, nullable=False, default="uploaded")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    project = relationship("Project", back_populates="documents")
    pages = relationship("DocumentPage", back_populates="document")
    extraction_jobs = relationship("ExtractionJob", back_populates="document")

class DocumentPage(Base):
    __tablename__ = "document_pages"

    id = Column(Integer, primary_key=True, index=True)
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=False)
    page_number = Column(Integer, nullable=False)
    text = Column(Text, nullable=True)
    image_path = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    document = relationship("Document", back_populates="pages")

class ExtractionJob(Base):
    __tablename__ = "extraction_jobs"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=False)
    template_id = Column(Integer, ForeignKey("templates.id"), nullable=False)
    status = Column(String, nullable=False, default="pending")
    progress = Column(Integer, nullable=False, default=0)
    current_page = Column(Integer, nullable=False, default=0)
    total_pages = Column(Integer, nullable=False, default=0)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    project = relationship("Project", back_populates="extraction_jobs")
    document = relationship("Document", back_populates="extraction_jobs")
    template = relationship("Template")
    extracted_fields = relationship("ExtractedField", back_populates="extraction_job")

class ExtractedField(Base):
    __tablename__ = "extracted_fields"

    id = Column(Integer, primary_key=True, index=True)
    extraction_job_id = Column(Integer, ForeignKey("extraction_jobs.id"), nullable=False)
    field_id = Column(String, nullable=False)
    field_label = Column(String, nullable=False)
    value = Column(Text, nullable=True)
    confidence = Column(Float, nullable=True)
    validation_status = Column(String, nullable=False, default="pending")
    # Result of "Verify Document & Template" (MATCH / MISMATCH / NOT FOUND /
    # REVIEW). Separate from validation_status, which tracks the human
    # accept/edit/reject workflow - this tracks the automated comparison
    # against what the matched master template requires.
    verification_status = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    extraction_job = relationship("ExtractionJob", back_populates="extracted_fields")
    source_references = relationship("SourceReference", back_populates="extracted_field")

class SourceReference(Base):
    __tablename__ = "source_references"

    id = Column(Integer, primary_key=True, index=True)
    extracted_field_id = Column(Integer, ForeignKey("extracted_fields.id"), nullable=False)
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=False)
    page_number = Column(Integer, nullable=True)
    source_text = Column(Text, nullable=True)
    confidence = Column(Float, nullable=True)
    bounding_box = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    extracted_field = relationship("ExtractedField", back_populates="source_references")