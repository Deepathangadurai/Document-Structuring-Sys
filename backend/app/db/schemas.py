from typing import List, Optional, Any
from pydantic import BaseModel, Field

class TemplateField(BaseModel):
    field_id: str
    field_label: str
    data_type: str
    required: bool
    extraction_hint: Optional[str] = None
    default_value: Optional[str] = None
    validation_rules: Optional[List[Any]] = Field(default_factory=list)
    page_number: Optional[int] = None

    class Config:
        from_attributes = True

class TemplateSection(BaseModel):
    section_id: str
    section_name: str
    section_number: Optional[str] = None
    page_number: Optional[int] = None
    columns: Optional[List[str]] = None
    rows: Optional[List[Any]] = None
    fields: List[TemplateField] = Field(default_factory=list)

    class Config:
        from_attributes = True

class DocumentSection(BaseModel):
    """A section of the document with full HTML content and metadata."""
    section_id: str
    section_name: str
    section_number: int = 0
    content_html: str
    paragraphs: List[Any] = Field(default_factory=list)

    class Config:
        from_attributes = True

class StaticBlock(BaseModel):
    """A paragraph/heading/table with no detected dynamic field - fixed
    wording that's part of the master template itself. Still editable (to
    fix the master template's own text), separately from field values."""
    block_id: str
    page_number: int
    block_type: str  # 'paragraph' | 'heading' | 'table'
    text: str
    looks_like_blank_field: bool = False
    # Present only for block_type == 'paragraph'/'heading'; identifies the
    # exact paragraph in doc.paragraphs so an edit can be written back
    # in place. None for 'table' blocks, which are read-only for now.
    paragraph_index: Optional[int] = None

    class Config:
        from_attributes = True

class TemplateListResponse(BaseModel):
    template_id: str
    template_name: str
    version: str
    specification_number: Optional[str] = None
    description: Optional[str] = None
    structure_locked: bool = False
    content_page: Optional[List[dict[str, str]]] = Field(default_factory=list)
    sections: List[TemplateSection] = Field(default_factory=list)
    page_count: int = 1
    preview_html: Optional[str] = None
    document_sections: List[DocumentSection] = Field(default_factory=list)
    page_images: List[str] = Field(default_factory=list)
    # Per-page HTML fallback rendered directly from the .docx (no
    # LibreOffice/soffice dependency). Used by the page review UI when
    # page_images[i] is missing or soffice conversion failed.
    page_html: List[str] = Field(default_factory=list)
    static_blocks: List[StaticBlock] = Field(default_factory=list)

    class Config:
        from_attributes = True

class TemplatePreviewResponse(TemplateListResponse):
    pass

class TemplateDetailResponse(TemplatePreviewResponse):
    pass

class PendingTemplateResponse(TemplateListResponse):
    id: int
    status: str
    source_filename: Optional[str] = None
    text_preview: Optional[str] = None
    structure_locked: bool = False
    document_sections: List[DocumentSection] = Field(default_factory=list)



class PendingTemplateUpdateRequest(BaseModel):
    template_name: Optional[str] = None
    description: Optional[str] = None
    specification_number: Optional[str] = None
    sections: Optional[List[TemplateSection]] = None
    static_blocks: Optional[List[StaticBlock]] = None

class CreateProjectRequest(BaseModel):
    project_name: str
    project_code: Optional[str] = None
    # Optional now: a project starts from ONE uploaded document and
    # specifications are detected from it. Kept for backward compatibility
    # with the old up-front-template flow.
    template_id: Optional[str] = None

class ProjectResponse(BaseModel):
    id: int
    project_name: str
    project_code: Optional[str] = None
    template_id: Optional[str] = None
    template_name: Optional[str] = None
    template_version: Optional[str] = None
    status: str
    created_at: str
    updated_at: str
    document_count: int = 0
    latest_job_status: Optional[str] = None

    class Config:
        from_attributes = True

class ProjectDetailResponse(ProjectResponse):
    documents: List[Any] = Field(default_factory=list)
    extraction_jobs: List[Any] = Field(default_factory=list)



class DocumentMetadataResponse(BaseModel):
    id: int
    project_id: int
    original_filename: str
    stored_filename: str
    file_type: str
    file_size: int
    page_count: int
    upload_status: str
    created_at: str

    class Config:
        from_attributes = True

class CreateExtractionRequest(BaseModel):
    document_id: int
    # Which detected specification (master template) to extract this
    # document against. String template_id (e.g. "specification_01"), not
    # the numeric DB id. Optional for backward compatibility with the old
    # flow where the project itself carried a single template.
    template_id: Optional[str] = None

class SourceReferenceResponse(BaseModel):
    page_number: Optional[int] = None
    source_text: Optional[str] = None
    confidence: Optional[float] = None
    bounding_box: Optional[Any] = None

    class Config:
        from_attributes = True

class ExtractedFieldResponse(BaseModel):
    field_id: str
    field_label: str
    value: Optional[str] = None
    original_value: Optional[str] = None
    confidence: Optional[float] = None
    validation_status: str
    verification_status: Optional[str] = None
    default_value: Optional[str] = None
    is_default: Optional[bool] = None
    source_references: List[SourceReferenceResponse] = Field(default_factory=list)

    class Config:
        from_attributes = True

class ExtractionJobResponse(BaseModel):
    id: int
    project_id: int
    document_id: int
    template_id: int
    template_code: Optional[str] = None
    template_name: Optional[str] = None
    status: str
    progress: int
    current_page: int
    total_pages: int
    error_message: Optional[str] = None
    created_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    extracted_fields: List[ExtractedFieldResponse] = Field(default_factory=list)
    populated_tree: Optional[dict[str, Any]] = None

    class Config:
        from_attributes = True

class DetectedSpecificationResponse(BaseModel):
    """One entry per master template checked against a project's uploaded
    source document (see SpecificationMatcher). match_status is one of
    'matched' | 'review' | 'not_found'."""
    template_id: str
    template_name: str
    specification_number: Optional[str] = None
    match_status: str
    match_confidence: float
    matched_pages: List[int] = Field(default_factory=list)

class FieldVerificationResponse(BaseModel):
    """Result of comparing one extracted value against what its matched
    template requires. status is one of
    'match' | 'mismatch' | 'not_found' | 'review'."""
    field_id: str
    status: str
    expected_hint: Optional[str] = None
    reason: Optional[str] = None
    # Whether the template schema marks this field as required. Surfaced so
    # the frontend's manual-entry form can prioritize and flag required
    # NOT_FOUND fields distinctly from optional ones, without re-deriving
    # it from `reason` text.
    required: bool = False

class ModelHealthResponse(BaseModel):
    available: bool
    model: str
    provider: str
    device: Optional[str] = None
    reason: Optional[str] = None

    class Config:
        from_attributes = True

class DashboardStatsResponse(BaseModel):
    total_projects: int
    projects_created_this_month: int
    documents_processed: int
    documents_processed_this_week: int
    extraction_accuracy: Optional[float] = None
    pending_validation: int
    active_templates: int

class FieldUpdateRequest(BaseModel):
    value: Optional[str] = None
    validation_status: str

class PageResponse(BaseModel):
    document_id: int
    page_number: int
    text: Optional[str] = None
    has_image: bool = False
    total_pages: int = 0