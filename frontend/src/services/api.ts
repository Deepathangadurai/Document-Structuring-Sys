/// <reference types="vite/client" />

import type {
  CreateExtractionRequest,
  CreateProjectRequest,
  DashboardStatsResponse,
  DetectedSpecificationResponse,
  DocumentMetadataResponse,
  ExtractionJobResponse,
  FieldUpdateRequest,
  ExtractedFieldResponse,
  FieldVerificationResponse,
  PageResponse,
  PendingTemplateResponse,
  PendingTemplateUpdateRequest,
  ProjectDetailResponse,
  ProjectResponse,
  TemplateListResponse,
} from '../types'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = await response.json()
      message = body.detail ? (typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)) : message
    } catch {
      // response wasn't JSON - fall back to statusText
    }
    throw new Error(message)
  }
  return response.json()
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  return handleResponse<T>(await fetch(url, { cache: 'no-store', ...init }))
}

// fetch() has no way to observe upload progress in the browser - only
// download/response progress via streaming the response body. XHR is the
// only option that exposes `upload.onprogress`, so file uploads that need
// a progress bar go through this instead of fetchJson.
function uploadWithProgress<T>(
  url: string,
  form: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)

    xhr.upload.onprogress = (event) => {
      if (!onProgress || !event.lengthComputable) return
      onProgress(Math.round((event.loaded / event.total) * 100))
    }

    xhr.onload = () => {
      let body: unknown = undefined
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined
      } catch {
        // response wasn't JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100)
        resolve(body as T)
      } else {
        const detail = (body as { detail?: unknown } | undefined)?.detail
        const message = detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : xhr.statusText
        reject(new Error(message || `Upload failed with status ${xhr.status}`))
      }
    }

    xhr.onerror = () => reject(new Error('Upload failed - could not reach the server.'))
    xhr.onabort = () => reject(new Error('Upload cancelled.'))

    xhr.send(form)
  })
}

// ---- Templates ----

export async function getTemplates(): Promise<TemplateListResponse[]> {
  return fetchJson(`${API_BASE}/templates`)
}

export async function getTemplate(templateId: string): Promise<TemplateListResponse> {
  return fetchJson(`${API_BASE}/templates/${templateId}`)
}

// ---- Pending templates (upload -> validate/preview -> approve) ----

export async function listPendingTemplates(): Promise<PendingTemplateResponse[]> {
  return fetchJson(`${API_BASE}/templates/pending`)
}

export async function getPendingTemplate(id: number): Promise<PendingTemplateResponse> {
  return fetchJson(`${API_BASE}/templates/pending/${id}`)
}

export async function uploadTemplate(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<PendingTemplateResponse> {
  const form = new FormData()
  form.append('file', file)
  return uploadWithProgress(`${API_BASE}/templates/upload`, form, onProgress)
}

export async function updatePendingTemplate(
  id: number,
  payload: PendingTemplateUpdateRequest,
): Promise<PendingTemplateResponse> {
  return handleResponse(
    await fetch(`${API_BASE}/templates/pending/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(payload),
    }),
  )
}

export async function approvePendingTemplate(id: number): Promise<TemplateListResponse> {
  return handleResponse(
    await fetch(`${API_BASE}/templates/pending/${id}/approve`, { method: 'POST', cache: 'no-store' }),
  )
}

export async function rejectPendingTemplate(id: number): Promise<{ deleted: boolean }> {
  return handleResponse(
    await fetch(`${API_BASE}/templates/pending/${id}`, { method: 'DELETE', cache: 'no-store' }),
  )
}

// ---- Projects ----

export async function listProjects(): Promise<ProjectResponse[]> {
  return fetchJson(`${API_BASE}/projects`)
}

export async function getProject(projectId: number): Promise<ProjectDetailResponse> {
  return fetchJson(`${API_BASE}/projects/${projectId}`)
}

export async function createProject(payload: CreateProjectRequest): Promise<ProjectResponse> {
  return handleResponse(
    await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

// ---- Documents ----

export async function uploadDocument(
  projectId: number,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<DocumentMetadataResponse> {
  const form = new FormData()
  form.append('file', file)
  return uploadWithProgress(`${API_BASE}/projects/${projectId}/documents`, form, onProgress)
}

export async function listProjectDocuments(projectId: number): Promise<DocumentMetadataResponse[]> {
  return fetchJson(`${API_BASE}/projects/${projectId}/documents`)
}

// ---- Specification detection & matching ----
// Runs Docling/OCR page-by-page over the project's uploaded source
// document, checks which of the master templates (13 in production; the
// 3 sample templates for now) it can find inside it, and returns one
// entry per detected specification with a match confidence and the pages
// it was found on. NEW backend endpoint — not implemented server-side yet.
export async function detectSpecifications(projectId: number): Promise<DetectedSpecificationResponse[]> {
  return handleResponse(
    await fetch(`${API_BASE}/projects/${projectId}/detect-specifications`, {
      method: 'POST',
      cache: 'no-store',
    }),
  )
}

// Runs "Verify Document & Template" for a completed extraction job:
// compares every extracted value against what its matched template
// requires and returns a MATCH / MISMATCH / NOT FOUND / REVIEW verdict
// per field. NEW backend endpoint — not implemented server-side yet.
export async function verifyExtraction(jobId: number): Promise<FieldVerificationResponse[]> {
  return fetchJson(`${API_BASE}/extraction/${jobId}/verify`)
}

export async function listDocumentPages(documentId: number): Promise<PageResponse[]> {
  return fetchJson(`${API_BASE}/documents/${documentId}/pages`)
}

export async function getDocumentPage(documentId: number, pageNumber: number): Promise<PageResponse> {
  return fetchJson(`${API_BASE}/documents/${documentId}/pages/${pageNumber}`)
}

export function getDocumentPageImageUrl(documentId: number, pageNumber: number): string {
  return `${API_BASE}/documents/${documentId}/pages/${pageNumber}/image`
}

// ---- Extraction ----

export function getExtractionExportUrl(jobId: number, format: 'json' | 'docx'): string {
  return `${API_BASE}/extraction/${jobId}/export?format=${format}`
}

export async function startExtraction(projectId: number, payload: CreateExtractionRequest): Promise<ExtractionJobResponse> {
  return handleResponse(
    await fetch(`${API_BASE}/projects/${projectId}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function getExtraction(jobId: number): Promise<ExtractionJobResponse> {
  return fetchJson(`${API_BASE}/extraction/${jobId}`)
}

export async function getExtractionResults(jobId: number): Promise<ExtractionJobResponse> {
  return fetchJson(`${API_BASE}/extraction/${jobId}/results`)
}

export async function updateExtractedField(
  jobId: number,
  fieldId: string,
  payload: FieldUpdateRequest,
): Promise<ExtractedFieldResponse> {
  return handleResponse(
    await fetch(`${API_BASE}/extraction/${jobId}/fields/${fieldId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

// ---- Dashboard ----

export async function getDashboardStats(): Promise<DashboardStatsResponse> {
  return handleResponse(await fetch(`${API_BASE}/dashboard/stats`))
}