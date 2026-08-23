export interface TemplateField {
  field_id: string
  field_label: string
  data_type: string
  required: boolean
  page_number?: number | null
  extraction_hint?: string | null
  validation_rules?: unknown[]
}

export interface TemplateSection {
  section_id: string
  section_name: string
  fields: TemplateField[]
}

export interface DocumentSection {
  section_id: string
  section_name: string
  section_number: number
  content_html: string
  paragraphs: unknown[]
}

export interface StaticBlock {
  block_id: string
  page_number: number
  block_type: 'paragraph' | 'heading' | 'table'
  text: string
  looks_like_blank_field: boolean
  // Only present for paragraph/heading blocks - identifies exactly which
  // paragraph an edit gets written back into. Table blocks are read-only.
  paragraph_index?: number | null
}

export interface TemplateListResponse {
  template_id: string
  template_name: string
  version: string
  specification_number?: string | null
  description?: string | null
  structure_locked?: boolean
  sections?: TemplateSection[]
  page_count?: number
  preview_html?: string | null
  document_sections?: DocumentSection[]
  page_images?: string[]
  // Per-page HTML rendered directly from the .docx, independent of
  // LibreOffice/soffice. Used as a fallback when page_images[i] is missing.
  page_html?: string[]
  static_blocks?: StaticBlock[]
}

export interface PendingTemplateResponse extends TemplateListResponse {
  id: number
  status: string
  source_filename?: string | null
  text_preview?: string | null
}

export interface PendingTemplateUpdateRequest {
  template_name?: string
  description?: string | null
  specification_number?: string | null
  sections?: TemplateSection[]
  static_blocks?: StaticBlock[]
}

export interface ProjectResponse {
  id: number
  project_name: string
  template_id?: string | null
  template_name?: string | null
  template_version?: string | null
  status: string
  created_at: string
  updated_at: string
  document_count: number
  latest_job_status?: string | null
}

export interface ProjectDetailResponse extends ProjectResponse {
  documents: DocumentMetadataResponse[]
  extraction_jobs: ExtractionJobResponse[]
}

export interface DocumentMetadataResponse {
  id: number
  project_id: number
  original_filename: string
  stored_filename: string
  file_type: string
  file_size: number
  page_count: number
  upload_status: string
  created_at: string
}

export interface SourceReferenceResponse {
  page_number?: number | null
  source_text?: string | null
  confidence?: number | null
  bounding_box?: unknown | null
}

// Backend validation_status values
export type ValidationStatus = 'pending' | 'verified' | 'missing' | 'review' | 'rejected'

export interface ExtractedFieldResponse {
  field_id: string
  field_label: string
  value?: string | null
  // Immutable snapshot of what extraction originally produced, before any
  // edit/approve/reject. Never changes after the field is created - lets
  // the UI offer an "Undo" back to it.
  original_value?: string | null
  confidence?: number | null
  validation_status: string
  // Result of comparing this value to the matched template's requirement
  // during "Verify Document & Template". Optional because it's only
  // populated after a verify pass has run for the job.
  verification_status?: VerificationStatus | null
  source_references: SourceReferenceResponse[]
}

export interface ExtractionJobResponse {
  id: number
  project_id: number
  document_id: number
  template_id: number
  template_code?: string | null
  template_name?: string | null
  status: string
  progress: number
  current_page: number
  total_pages: number
  error_message?: string | null
  created_at: string
  started_at?: string | null
  completed_at?: string | null
  extracted_fields?: ExtractedFieldResponse[]
}

export interface CreateProjectRequest {
  project_name: string
  template_id?: string
  project_code?: string
}

// ---- Specification detection & matching (new multi-spec workflow) ----
// A project now starts from ONE uploaded source document. The backend scans
// it against all master templates (13 in production; 3 sample templates —
// specification_01/02/03 — while the rest are being added) and reports
// which specifications it found and how confident it is in each match.
export type SpecMatchStatus = 'matched' | 'review' | 'not_found'

export interface DetectedSpecificationResponse {
  template_id: string
  template_name: string
  specification_number?: string | null
  match_status: SpecMatchStatus
  match_confidence: number // 0-1
  matched_pages: number[]
}

// ---- Verification (MATCH / MISMATCH / NOT FOUND / REVIEW) ----
// Produced by "Verify Document & Template": compares each extracted value
// against what the matched master template requires.
export type VerificationStatus = 'match' | 'mismatch' | 'not_found' | 'review'

export interface FieldVerificationResponse {
  field_id: string
  status: VerificationStatus
  expected_hint?: string | null
  reason?: string | null
  required?: boolean
}

export interface CreateExtractionRequest {
  document_id: number
  template_id?: string
}

export interface FieldUpdateRequest {
  value?: string | null
  validation_status: ValidationStatus
}

export interface PageResponse {
  document_id: number
  page_number: number
  text?: string | null
  has_image: boolean
  total_pages: number
}

export interface DashboardStatsResponse {
  total_projects: number
  projects_created_this_month: number
  documents_processed: number
  documents_processed_this_week: number
  extraction_accuracy?: number | null
  pending_validation: number
  active_templates: number
}