import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import { Icons } from './icons'
import { getProject, getExtractionExportUrl, updateExtractedField } from '../services/api'
import type {
  DocumentMetadataResponse,
  ExtractedFieldResponse,
  ExtractionJobResponse,
  ProjectDetailResponse,
} from '../types'

interface PagePreview {
  page_number: number
  total_pages: number
  page_image_url: string
  page_html: string
  fields: any[]
}

function getFieldDisplayValue(field: ExtractedFieldResponse): string {
  return field.value ?? ''
}

// Visual language for a field span's current state, applied directly to
// the tagged <span data-field-id> inside the rendered document - this is
// the only place a value's status is shown, there is no separate status
// column anywhere else.
const STATUS_STYLE: Record<string, string> = {
  verified: 'background:#dcfce7; outline:1px solid #16a34a; outline-offset:1px; padding:0 2px; border-radius:2px;',
  rejected: 'background:#f1f5f9; outline:1px dashed #94a3b8; outline-offset:1px; padding:0 2px; border-radius:2px; color:#94a3b8; font-style:italic;',
  review: 'background:#fef3c7; outline:1px solid #d97706; outline-offset:1px; padding:0 2px; border-radius:2px;',
  missing: 'background:#fee2e2; outline:1px dashed #dc2626; outline-offset:1px; padding:0 2px; border-radius:2px;',
  pending: 'background:#fff8dc; outline:1px dashed #c99a1e; outline-offset:1px; padding:0 2px; border-radius:2px;',
}

export default function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()

  const [project, setProject] = useState<ProjectDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedDocumentId, setSelectedDocumentId] = useState<number | null>(null)
  const [activePage, setActivePage] = useState(1)
  const [pagePreview, setPagePreview] = useState<PagePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Edits made directly in the document, keyed by field_id, not yet saved
  // via an approve/reject call. This is the single source of truth for
  // "what does this field currently say" - the document DOM and this map
  // are always kept in sync with each other; there's no separate text
  // input anywhere else that could get out of sync with it.
  const [edits, setEdits] = useState<{ [fieldId: string]: string }>({})
  const [savingFieldId, setSavingFieldId] = useState<string | null>(null)

  const docRef = useRef<HTMLDivElement>(null)

  async function loadProject() {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const data = await getProject(Number(projectId))
      setProject(data)
      setSelectedDocumentId((current) => {
        if (current !== null) return current
        return data.documents.length > 0 ? data.documents[0].id : null
      })
    } catch (err) {
      setError(`Could not load project: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProject()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Poll while any job is still processing, so results appear without a refresh.
  useEffect(() => {
    if (!project) return
    const hasActiveJob = project.extraction_jobs.some(
      (job) => job.status === 'processing' || job.status === 'pending',
    )
    if (!hasActiveJob) return
    const timer = window.setInterval(() => {
      void loadProject()
    }, 3000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])

  const selectedDocument = project?.documents.find((d) => d.id === selectedDocumentId) ?? null

  const jobForSelectedDocument: ExtractionJobResponse | null = useMemo(() => {
    if (!project || !selectedDocumentId) return null
    const jobsForDoc = project.extraction_jobs.filter((j) => j.document_id === selectedDocumentId)
    if (jobsForDoc.length === 0) return null
    return jobsForDoc.reduce((latest, job) => (job.id > latest.id ? job : latest))
  }, [project, selectedDocumentId])

  // Reset to page 1 and clear any unsaved edits whenever the selected
  // document (and therefore the job/template driving the preview) changes.
  useEffect(() => {
    setActivePage(1)
    setEdits({})
  }, [selectedDocumentId])

  // Fetch the *template's* rendered page HTML - this is the actual output
  // document's structure (tables, headings, layout), not a re-parse of the
  // uploaded source file, so editing it and downloading afterwards are
  // looking at the same thing. Field values are then overlaid from the
  // extraction job below. Reuses the same preview endpoint the Template
  // review screen uses (it looks a template up by numeric id regardless
  // of pending/active status), so table rendering and page structure are
  // identical in both places.
  useEffect(() => {
    if (!jobForSelectedDocument) {
      setPagePreview(null)
      return
    }
    let cancelled = false
    async function loadPreview() {
      setPreviewLoading(true)
      setPreviewError(null)
      try {
        const res = await fetch(
          `/api/templates/pending/${jobForSelectedDocument!.template_id}/pages/${activePage}/preview`,
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.detail || `Failed to load page ${activePage} (HTTP ${res.status})`)
        }
        const data = await res.json()
        if (!cancelled) setPagePreview(data)
      } catch (err) {
        if (!cancelled) {
          setPagePreview(null)
          setPreviewError((err as Error).message)
        }
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }
    void loadPreview()
    return () => {
      cancelled = true
    }
  }, [jobForSelectedDocument, activePage])

  const extractedFields = jobForSelectedDocument?.extracted_fields ?? []
  const extractedByFieldId = useMemo(() => {
    const map: { [fieldId: string]: ExtractedFieldResponse } = {}
    for (const f of extractedFields) map[f.field_id] = f
    return map
  }, [extractedFields])

  // Only the fields that actually live on the currently-rendered page
  // (matched against the tagged spans in pagePreview.page_html), so the
  // side list always points at things visible in the document right now.
  const fieldsOnPage = useMemo(() => {
    if (!pagePreview?.page_html) return []
    const ids = new Set<string>()
    const regex = /data-field-id="([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = regex.exec(pagePreview.page_html))) ids.add(m[1])
    return Array.from(ids)
      .map((id) => extractedByFieldId[id])
      .filter(Boolean) as ExtractedFieldResponse[]
  }, [pagePreview?.page_html, extractedByFieldId])

  // Paint each tagged span with the extracted value (or the user's
  // in-progress edit) and its status color, and wire typing in the
  // document straight into `edits`. This runs whenever the page HTML or
  // the underlying field data changes - the document is always the
  // single editable surface, nothing here reads from or writes to a
  // separate form.
  const bindEditableFields = useCallback(() => {
    const container = docRef.current
    if (!container) return
    const spans = container.querySelectorAll<HTMLElement>('[data-field-id]')
    spans.forEach((span) => {
      const fieldId = span.dataset.fieldId
      if (!fieldId) return
      const field = extractedByFieldId[fieldId]
      const value = edits[fieldId] ?? (field ? getFieldDisplayValue(field) : span.textContent || '')
      if (span.textContent !== value) span.textContent = value

      const status = field?.validation_status || 'pending'
      span.setAttribute('style', STATUS_STYLE[status] || STATUS_STYLE.pending)
      span.setAttribute('contenteditable', 'true')
      span.title = field ? `${field.field_label} - ${status}` : fieldId

      const handler = () => {
        const text = (span.textContent || '').trim()
        setEdits((prev) => (prev[fieldId] === text ? prev : { ...prev, [fieldId]: text }))
      }
      span.removeEventListener('input', (span as any).__fieldInputHandler)
      ;(span as any).__fieldInputHandler = handler
      span.addEventListener('input', handler)
    })
  }, [edits, extractedByFieldId])

  useEffect(() => {
    bindEditableFields()
    // Re-bind on new HTML or new extraction data, not on every keystroke -
    // the input handler above updates `edits` without forcing a full
    // re-render/re-bind that would fight the browser's own cursor handling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagePreview?.page_html, extractedByFieldId])

  const focusField = (fieldId: string) => {
    const el = docRef.current?.querySelector<HTMLElement>(`[data-field-id="${fieldId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }

  async function handleApprove(field: ExtractedFieldResponse) {
    if (!jobForSelectedDocument) return
    setSavingFieldId(field.field_id)
    try {
      const value = edits[field.field_id] ?? getFieldDisplayValue(field)
      await updateExtractedField(jobForSelectedDocument.id, field.field_id, {
        value,
        validation_status: 'verified',
      })
      setEdits((prev) => {
        const next = { ...prev }
        delete next[field.field_id]
        return next
      })
      await loadProject()
    } catch (err) {
      setError(`Could not approve field: ${(err as Error).message}`)
    } finally {
      setSavingFieldId(null)
    }
  }

  // Rejecting clears the value out of the document (back to blank, the
  // same as an un-filled template placeholder) rather than just hiding it
  // in a UI list - the span in the document reflects the rejection
  // immediately, and the cleared value is what a docx download will use.
  async function handleReject(field: ExtractedFieldResponse) {
    if (!jobForSelectedDocument) return
    setSavingFieldId(field.field_id)
    try {
      await updateExtractedField(jobForSelectedDocument.id, field.field_id, {
        value: '',
        validation_status: 'rejected',
      })
      setEdits((prev) => ({ ...prev, [field.field_id]: '' }))
      const span = docRef.current?.querySelector<HTMLElement>(`[data-field-id="${field.field_id}"]`)
      if (span) span.textContent = ''
      await loadProject()
    } catch (err) {
      setError(`Could not reject field: ${(err as Error).message}`)
    } finally {
      setSavingFieldId(null)
    }
  }

  if (loading && !project) {
    return <div className="p-8 max-w-6xl mx-auto text-sm text-slate-500">Loading project…</div>
  }

  if (error && !project) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      </div>
    )
  }

  if (!project) return null

  const totalPages = pagePreview?.total_pages || 1

  return (
    <div className="p-8 max-w-7xl mx-auto pb-20">
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => navigate('/projects')}>
          <Icons.ChevronLeft className="w-4 h-4 mr-1" /> Back to Projects
        </Button>
      </div>

      <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-1">{project.project_name}</h1>
            <p className="text-slate-500 text-sm">
              Template: {project.template_name} (v{project.template_version})
            </p>
          </div>
          <Badge type={project.status}>{project.status}</Badge>
        </div>
      </div>

      {error ? (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      ) : null}

      {project.documents.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-500">
          No documents uploaded to this project yet.
        </Card>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          {/* Documents */}
          <div className="col-span-1 space-y-4">
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">
                Documents
              </div>
              <ul className="divide-y divide-slate-100">
                {project.documents.map((doc: DocumentMetadataResponse) => {
                  const job = project.extraction_jobs
                    .filter((j) => j.document_id === doc.id)
                    .reduce<ExtractionJobResponse | null>(
                      (latest, j) => (!latest || j.id > latest.id ? j : latest),
                      null,
                    )
                  return (
                    <li key={doc.id}>
                      <button
                        onClick={() => setSelectedDocumentId(doc.id)}
                        className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                          selectedDocumentId === doc.id ? 'bg-blue-50' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-900 truncate">{doc.original_filename}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-xs text-slate-500">{doc.page_count} page(s)</span>
                          {job ? <Badge type={job.status}>{job.status}</Badge> : <Badge type="draft">no job</Badge>}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Card>

            {jobForSelectedDocument?.status === 'completed' ? (
              <Card className="p-4 space-y-2">
                <p className="text-xs text-slate-500 mb-1">
                  Downloads reflect exactly what's shown in the document on the right, including any
                  approvals/rejections you've made.
                </p>
                <a href={getExtractionExportUrl(jobForSelectedDocument.id, 'docx')} className="block">
                  <Button variant="secondary" className="w-full">
                    <Icons.Download className="w-4 h-4" /> Download Word Document
                  </Button>
                </a>
                <a href={getExtractionExportUrl(jobForSelectedDocument.id, 'json')} className="block">
                  <Button variant="secondary" className="w-full">
                    <Icons.Download className="w-4 h-4" /> Download JSON
                  </Button>
                </a>
              </Card>
            ) : null}

            {/* Field checklist - navigation + approve/reject only. Editing
                the value itself only ever happens in the document pane;
                nothing here is a text input. */}
            <Card className="p-4">
              <h3 className="font-semibold mb-1 text-sm">Values on This Page</h3>
              <p className="text-xs text-slate-500 mb-3">
                Edit values directly in the document. Approve or reject each one here.
              </p>
              {!jobForSelectedDocument ? (
                <p className="text-slate-500 text-sm">No extraction job for this document yet.</p>
              ) : fieldsOnPage.length === 0 ? (
                <p className="text-slate-500 text-sm">No values detected on this page.</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {fieldsOnPage.map((field) => {
                    const isSaving = savingFieldId === field.field_id
                    const currentValue = edits[field.field_id] ?? getFieldDisplayValue(field)
                    return (
                      <div
                        key={field.field_id}
                        className="rounded border border-slate-200 bg-white p-2.5 hover:border-blue-400 transition-colors"
                      >
                        <button
                          type="button"
                          onClick={() => focusField(field.field_id)}
                          className="w-full text-left"
                        >
                          <div className="font-medium text-slate-900 text-xs">{field.field_label}</div>
                          <div className="text-xs text-slate-600 mt-0.5 truncate">
                            {currentValue || <span className="italic text-slate-400">empty</span>}
                          </div>
                        </button>
                        <div className="flex items-center gap-2 mt-2">
                          <Badge type={field.validation_status}>{field.validation_status}</Badge>
                          <div className="flex-1" />
                          <button
                            disabled={isSaving}
                            onClick={() => void handleApprove(field)}
                            className="text-green-600 hover:text-green-700 disabled:opacity-40"
                            title="Approve this value"
                          >
                            <Icons.Check className="w-4 h-4" />
                          </button>
                          <button
                            disabled={isSaving}
                            onClick={() => void handleReject(field)}
                            className="text-red-600 hover:text-red-700 disabled:opacity-40"
                            title="Reject and clear this value"
                          >
                            <Icons.X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* The document itself - the edit surface */}
          <div className="col-span-2">
            <Card className="overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Output Document</h2>
                  {jobForSelectedDocument ? (
                    <p className="text-xs text-slate-500 mt-0.5">
                      Job #{jobForSelectedDocument.id} · {jobForSelectedDocument.status}
                      {jobForSelectedDocument.status === 'failed' && jobForSelectedDocument.error_message
                        ? ` — ${jobForSelectedDocument.error_message}`
                        : ''}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500 mt-0.5">No extraction job for this document yet.</p>
                  )}
                </div>
                {totalPages > 1 ? (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      className="p-1 rounded hover:bg-slate-100 disabled:opacity-30"
                      disabled={activePage <= 1}
                      onClick={() => setActivePage((p) => Math.max(1, p - 1))}
                    >
                      <Icons.ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <span>
                      {activePage} / {totalPages}
                    </span>
                    <button
                      className="p-1 rounded hover:bg-slate-100 disabled:opacity-30"
                      disabled={activePage >= totalPages}
                      onClick={() => setActivePage((p) => Math.min(totalPages, p + 1))}
                    >
                      <Icons.ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="p-6">
                {jobForSelectedDocument?.status === 'processing' || jobForSelectedDocument?.status === 'pending' ? (
                  <div className="p-8 text-center">
                    <div className="w-6 h-6 mx-auto rounded-full border-2 border-blue-500 border-t-transparent animate-spin mb-3" />
                    <p className="text-sm text-slate-500">
                      Extracting… page {jobForSelectedDocument.current_page} of {jobForSelectedDocument.total_pages} (
                      {jobForSelectedDocument.progress}%)
                    </p>
                  </div>
                ) : !jobForSelectedDocument ? (
                  <p className="text-sm text-slate-400 text-center py-8">
                    Start an extraction for this document to see the populated output here.
                  </p>
                ) : previewLoading ? (
                  <p className="text-sm text-slate-400 text-center py-8">Loading document…</p>
                ) : previewError ? (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                    {previewError}
                  </div>
                ) : !pagePreview?.page_html ? (
                  <p className="text-sm text-slate-400 text-center py-8">
                    No rendered page available for this template/page yet.
                  </p>
                ) : (
                  <div
                    ref={docRef}
                    className="prose prose-sm max-w-none bg-white border border-slate-200 rounded p-6 [&_table]:w-full [&_td]:align-top"
                    dangerouslySetInnerHTML={{ __html: pagePreview.page_html }}
                  />
                )}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}