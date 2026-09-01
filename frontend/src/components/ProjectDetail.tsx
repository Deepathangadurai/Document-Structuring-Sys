import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import { Icons } from './icons'
import { getProject, getExtractionExportUrl, updateExtractedField, verifyExtraction } from '../services/api'
import type {
  ExtractedFieldResponse,
  ExtractionJobResponse,
  FieldVerificationResponse,
  ProjectDetailResponse,
  VerificationStatus,
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

// "Verify Document & Template" verdicts map onto the same badge component
// used everywhere else in the app (see ui.tsx BADGE_STYLES).
function verifyBadgeType(status: VerificationStatus): string {
  if (status === 'match') return 'verified'
  if (status === 'mismatch') return 'rejected'
  if (status === 'not_found') return 'missing'
  return 'review'
}
function verifyLabel(status: VerificationStatus): string {
  if (status === 'match') return 'MATCH'
  if (status === 'mismatch') return 'MISMATCH'
  if (status === 'not_found') return 'NOT FOUND'
  return 'REVIEW'
}

// Quick visual indicator for extracted vs expected match
function matchIndicator(extracted: string, defaultValue: string | undefined) {
  if (!defaultValue || !extracted) return null
  // Simple: if the extracted value is close enough to the default, treat as likely correct
  const a = extracted.trim().toLowerCase()
  const b = defaultValue.trim().toLowerCase()
  if (a === b) return { icon: '✓', color: 'text-green-600 bg-green-50', label: 'Exact match with template default' }
  // Partial match (one contains the other)
  if (a.includes(b) || b.includes(a)) return { icon: '~', color: 'text-amber-600 bg-amber-50', label: 'Partial match — review recommended' }
  return { icon: '≠', color: 'text-red-500 bg-red-50', label: 'Different from template default — review if correct' }
}

export default function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()

  const [project, setProject] = useState<ProjectDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedJobId, setSelectedJobId] = useState<number | null>(null)
  const [activePage, setActivePage] = useState(1)
  const [pagePreview, setPagePreview] = useState<PagePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // "Verify Document & Template" — per-field MATCH / MISMATCH / NOT FOUND /
  // REVIEW verdicts for the currently selected specification's job.
  const [verifyResults, setVerifyResults] = useState<FieldVerificationResponse[] | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [showVerifyPanel, setShowVerifyPanel] = useState(false)

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
      setSelectedJobId((current) => {
        if (current !== null) return current
        return data.extraction_jobs.length > 0 ? data.extraction_jobs[0].id : null
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

  const selectedJob: ExtractionJobResponse | null = useMemo(() => {
    if (!project || !selectedJobId) return null
    return project.extraction_jobs.find((j) => j.id === selectedJobId) ?? null
  }, [project, selectedJobId])
  const jobForSelectedDocument = selectedJob

  // Reset to page 1, clear unsaved edits, and clear any stale verification
  // results whenever the selected specification (job) changes.
  useEffect(() => {
    setActivePage(1)
    setEdits({})
    setVerifyResults(null)
    setVerifyError(null)
    setShowVerifyPanel(false)
  }, [selectedJobId])

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

  // Build a map of fieldId → template field definition (extraction_hint, default_value, clause_ref)
  // so the UI can show "expected vs extracted" side-by-side for each field.
  const templateFieldDefs = useMemo(() => {
    const map: Record<string, { extraction_hint?: string; default_value?: string; clause_ref?: string; required?: boolean }> = {}
    if (!project || !jobForSelectedDocument) return map
    // We don't have the template schema here yet — fetch it lazily from
    // pagePreview.fields_on_page (the preview endpoint already joins it)
    return map
  }, [project, jobForSelectedDocument])

  // Enrich template defs from fields_on_page whenever the preview loads
  const [enrichedDefs, setEnrichedDefs] = useState<Record<string, { extraction_hint?: string; default_value?: string; clause_ref?: string; required?: boolean }>>({})
  useEffect(() => {
    if (!pagePreview) return
    const newDefs: typeof enrichedDefs = {}
    const fields: any[] = Array.isArray((pagePreview as any).fields_on_page) ? (pagePreview as any).fields_on_page : []
    fields.forEach((f: any) => {
      if (f.field_id) newDefs[f.field_id] = { extraction_hint: f.extraction_hint, default_value: f.default_value, clause_ref: f.clause_ref, required: f.required }
    })
    setEnrichedDefs(prev => ({ ...prev, ...newDefs }))
  }, [pagePreview])

  const verifyByFieldId = useMemo(() => {
    const map: { [fieldId: string]: FieldVerificationResponse } = {}
    for (const v of verifyResults ?? []) map[v.field_id] = v
    return map
  }, [verifyResults])

  const verifySummary = useMemo(() => {
    const counts: Record<VerificationStatus, number> = { match: 0, mismatch: 0, not_found: 0, review: 0 }
    for (const v of verifyResults ?? []) counts[v.status] += 1
    return counts
  }, [verifyResults])

  async function handleVerify() {
    if (!jobForSelectedDocument) return
    setVerifying(true)
    setVerifyError(null)
    setShowVerifyPanel(true)
    try {
      const results = await verifyExtraction(jobForSelectedDocument.id)
      setVerifyResults(results)
    } catch (err) {
      setVerifyError(
        `Verification is not available yet: ${(err as Error).message}. This calls a new backend endpoint ` +
        `(GET /extraction/{jobId}/verify) that still needs to compare extracted values against the matched template's requirements.`,
      )
    } finally {
      setVerifying(false)
    }
  }

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
        ; (span as any).__fieldInputHandler = handler
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

  // Save the current (possibly user-edited) value as a pending review item.
  async function handleSaveEdit(field: ExtractedFieldResponse) {
    if (!jobForSelectedDocument) return
    const value = edits[field.field_id] ?? getFieldDisplayValue(field)
    setSavingFieldId(field.field_id)
    try {
      await updateExtractedField(jobForSelectedDocument.id, field.field_id, {
        value,
        validation_status: 'review',
      })
      setEdits((prev) => {
        const next = { ...prev }
        delete next[field.field_id]
        return next
      })
      await loadProject()
    } catch (err) {
      setError(`Could not save edit: ${(err as Error).message}`)
    } finally {
      setSavingFieldId(null)
    }
  }

  // Revert an unsaved in-document edit back to the last saved backend value.
  async function handleUndo(field: ExtractedFieldResponse) {
    const savedValue = getFieldDisplayValue(field)
    setEdits((prev) => {
      const next = { ...prev }
      delete next[field.field_id]
      return next
    })
    const span = docRef.current?.querySelector<HTMLElement>(`[data-field-id="${field.field_id}"]`)
    if (span) span.textContent = savedValue
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

      <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 mb-1">{project.project_name}</h1>
            <p className="text-slate-500 text-sm">
              {project.extraction_jobs.length} specification{project.extraction_jobs.length === 1 ? '' : 's'}{' '}
              detected from this project's source document
            </p>
          </div>
          <Badge type={project.status}>{project.status}</Badge>
        </div>
      </div>

      {error ? (
        <div className="mb-6 p-4 bg-danger-light border border-danger/20 rounded-lg text-sm text-danger">{error}</div>
      ) : null}

      {project.extraction_jobs.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-500">
          No specifications have been extracted for this project yet.
        </Card>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          {/* Specifications — one per matched master template. Each has its
              own extraction job and generates its own separate output file. */}
          <div className="col-span-1 space-y-4">
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-50 text-sm font-bold" style={{ color: '#1A3A6B' }}>
                📋 Specifications
              </div>
              <ul className="divide-y divide-slate-100">
                {project.extraction_jobs.map((job: ExtractionJobResponse) => {
                  return (
                    <li key={job.id}>
                      <button
                        onClick={() => setSelectedJobId(job.id)}
                        className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${selectedJobId === job.id ? 'bg-brand-light' : ''
                          }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-900 truncate">
                            {job.template_name ?? `Specification #${job.template_id}`}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-xs text-slate-500">
                            {job.template_code ?? `template #${job.template_id}`}
                          </span>
                          <Badge type={job.status}>{job.status}</Badge>
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
                  approvals/rejections you've made. This specification generates its own separate file.
                </p>
                <Button
                  className="w-full bg-[#1A3A6B] hover:bg-[#12294d] text-white font-semibold py-2.5 shadow-sm flex items-center justify-center gap-2 mb-2"
                  onClick={() => navigate(`/projects/${projectId}/report`)}
                >
                  ✨ Open in Custom Editor &amp; Rovo AI
                </Button>
                <a href={getExtractionExportUrl(jobForSelectedDocument.id, 'docx')} className="block">
                  <Button variant="secondary" className="w-full">
                    <Icons.Download className="w-4 h-4" /> Download Word Document
                  </Button>
                </a>
                <a href={getExtractionExportUrl(jobForSelectedDocument.id, 'pdf')} className="block">
                  <Button variant="secondary" className="w-full">
                    <Icons.Download className="w-4 h-4" /> Download PDF Report
                  </Button>
                </a>
                <a href={getExtractionExportUrl(jobForSelectedDocument.id, 'json')} className="block">
                  <Button variant="secondary" className="w-full">
                    <Icons.Download className="w-4 h-4" /> Download JSON
                  </Button>
                </a>
              </Card>
            ) : null}

            {/* Verify Document & Template — compares extracted values
                against what the matched master template requires. */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold text-sm">Verify Document &amp; Template</h3>
                <Button
                  variant="secondary"
                  className="!px-3 !py-1.5 !text-xs"
                  onClick={() => void handleVerify()}
                  disabled={!jobForSelectedDocument || verifying}
                >
                  {verifying ? 'Verifying…' : verifyResults ? 'Re-verify' : 'Run Verification'}
                </Button>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                Compares each extracted value with what this specification requires.
              </p>
              {showVerifyPanel ? (
                verifying ? (
                  <p className="text-xs text-slate-400">Comparing source values against template requirements…</p>
                ) : verifyError ? (
                  <p className="text-xs text-danger">{verifyError}</p>
                ) : verifyResults ? (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <Badge type="verified">MATCH</Badge> {verifySummary.match}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge type="rejected">MISMATCH</Badge> {verifySummary.mismatch}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge type="missing">NOT FOUND</Badge> {verifySummary.not_found}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge type="review">REVIEW</Badge> {verifySummary.review}
                    </div>
                  </div>
                ) : null
              ) : null}
            </Card>

            {/* Field editor - form style matching extraction form */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold text-sm">Values on This Page</h3>
                {fieldsOnPage.length > 0 && (
                  <Badge type={fieldsOnPage.some((f) => !(edits[f.field_id] ?? getFieldDisplayValue(f))) ? 'missing' : 'active'}>
                    {fieldsOnPage.length}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-slate-500 mb-3">
                Type a value below or click ↗ to jump to it in the document. Approve ✓ or reject ✕ when done.
              </p>
              {!jobForSelectedDocument ? (
                <p className="text-slate-500 text-sm">No extraction job for this document yet.</p>
              ) : fieldsOnPage.length === 0 ? (
                <p className="text-xs text-slate-400">No fields detected on this page.</p>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
                  {fieldsOnPage.map((field) => {
                    const isSaving = savingFieldId === field.field_id
                    const currentValue = edits[field.field_id] ?? getFieldDisplayValue(field)
                    const verdict = verifyByFieldId[field.field_id]
                    const def = enrichedDefs[field.field_id]
                    const isMissing = !currentValue
                    const isReview = verdict && verdict.status !== 'match'
                    return (
                      <div
                        key={field.field_id}
                        className={`rounded-md border p-3 transition-colors ${
                          isMissing
                            ? 'border-red-200 bg-red-50/40'
                            : isReview
                            ? 'border-amber-200 bg-amber-50/40'
                            : 'border-slate-200 bg-slate-50/60'
                        }`}
                      >
                        {/* Header row: label + badge + jump */}
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-1.5 flex-1 min-w-0">
                            <label className="text-xs font-semibold text-slate-800 truncate">
                              {field.field_label}
                              {def?.required && <span className="text-red-600 ml-0.5">*</span>}
                            </label>
                            {def?.clause_ref && (
                              <span className="text-[9px] font-mono bg-amber-100 text-amber-700 rounded px-1 py-px shrink-0">§ {def.clause_ref}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Badge type={field.validation_status}>{field.validation_status}</Badge>
                            {verdict && (
                              <Badge type={verifyBadgeType(verdict.status)} title={verdict.reason ?? undefined}>
                                {verifyLabel(verdict.status)}
                              </Badge>
                            )}
                            <button
                              type="button"
                              onClick={() => focusField(field.field_id)}
                              className="text-[11px] text-brand hover:underline shrink-0"
                              title="Jump to this field in the document"
                            >
                              ↗
                            </button>
                          </div>
                        </div>

                        {/* Hint / reason */}
                        {(verdict?.reason || def?.extraction_hint) && (
                          <p className="text-[11px] text-slate-500 mb-1.5">
                            {verdict?.reason ?? def?.extraction_hint}
                          </p>
                        )}

                        {/* Editable textarea */}
                        <textarea
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20 resize-none"
                          rows={currentValue && currentValue.length > 60 ? 3 : 1}
                          placeholder={isMissing ? 'Not found — enter value manually' : 'Edit value…'}
                          value={currentValue}
                          disabled={isSaving}
                          onChange={(e) => {
                            const val = e.target.value
                            setEdits((prev) => ({ ...prev, [field.field_id]: val }))
                            const span = docRef.current?.querySelector<HTMLElement>(`[data-field-id="${field.field_id}"]`)
                            if (span) span.textContent = val
                          }}
                        />

                        {/* Action row */}
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {field.confidence != null && (
                            <span className="text-[10px] text-slate-400">{Math.round(field.confidence * 100)}% conf</span>
                          )}
                          <div className="flex-1" />
                          {edits[field.field_id] !== undefined && edits[field.field_id] !== getFieldDisplayValue(field) && (
                            <button
                              type="button"
                              disabled={isSaving}
                              className="text-slate-500 hover:text-slate-700 disabled:opacity-30"
                              title="Undo unsaved edit"
                              onClick={() => void handleUndo(field)}
                            >
                              <Icons.Undo className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={isSaving}
                            className="text-[11px] font-medium text-slate-500 hover:text-slate-700 disabled:opacity-30 px-2 py-0.5 rounded border border-slate-200 hover:border-slate-400 transition-colors"
                            title="Save for review"
                            onClick={() => void handleSaveEdit(field)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            disabled={isSaving}
                            className="text-green-600 hover:text-green-700 disabled:opacity-40"
                            title="Approve this value"
                            onClick={() => void handleApprove(field)}
                          >
                            <Icons.Check className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            disabled={isSaving}
                            className="text-red-600 hover:text-red-700 disabled:opacity-40"
                            title="Reject and clear this value"
                            onClick={() => void handleReject(field)}
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

              <div className="p-6 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 12rem)' }}>
                {jobForSelectedDocument?.status === 'processing' || jobForSelectedDocument?.status === 'pending' ? (
                  <div className="p-8 text-center">
                    <div className="w-6 h-6 mx-auto rounded-full border-2 border-brand border-t-transparent animate-spin mb-3" />
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