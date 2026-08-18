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
}

export interface ProjectResponse {
  id: number
  project_name: string
  template_id: string
  template_name: string
  template_version: string
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
  confidence?: number | null
  validation_status: string
  source_references: SourceReferenceResponse[]
}

export interface ExtractionJobResponse {
  id: number
  project_id: number
  document_id: number
  template_id: number
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
  template_id: string
}

export interface CreateExtractionRequest {
  document_id: number
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