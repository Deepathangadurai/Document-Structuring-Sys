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
// A field's span collapses to just its 4px of horizontal padding when the
// value is empty (the exact case that matters most - missing fields) with
// no text to give it width, making it an almost-impossible click target
// inside a rendered document table. min-width/min-height give every span
// a real clickable footprint even at zero characters, so the highlighted
// box in the document is at minimum something a person can actually see
// and click - though editing itself now happens via the sidebar input,
// not by typing directly into this span (see startEditingField).
// "missing" used to be a solid pink/red block (#fee2e2 fill) sitting
// directly in the document - since it's the state most fields start in,
// that meant a strong red-ish color block was the dominant thing on the
// page, reading as loud/alarming (described as "orange") rather than "this
// one still needs a value." Toned down to a thin dashed outline with no
// fill, matching how a plain, un-filled-in field looks in Jira/most clean
// form UIs - still clearly marked (dashed red outline + light red text),
// just not a filled block.
const STATUS_STYLE: Record<string, string> = {
  verified: 'background:#f0fdf4; outline:1px solid #16a34a; outline-offset:1px; padding:1px 6px; border-radius:2px; min-width:60px; min-height:1.1em; display:inline-block;',
  rejected: 'background:transparent; outline:1px dashed #cbd5e1; outline-offset:1px; padding:1px 6px; border-radius:2px; color:#94a3b8; font-style:italic; min-width:60px; min-height:1.1em; display:inline-block;',
  review: 'background:#f0f7ff; outline:1px solid #1565c0; outline-offset:1px; padding:1px 6px; border-radius:2px; min-width:60px; min-height:1.1em; display:inline-block;',
  missing: 'background:transparent; outline:1px dashed #dc2626; outline-offset:1px; padding:1px 6px; border-radius:2px; color:#b91c1c; min-width:60px; min-height:1.1em; display:inline-block;',
  pending: 'background:transparent; outline:1px dashed #cbd5e1; outline-offset:1px; padding:1px 6px; border-radius:2px; color:#94a3b8; min-width:60px; min-height:1.1em; display:inline-block;',
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
  // Jira-style inline edit: clicking a field's value turns THAT ROW into a
  // real text input with confirm (check) / cancel (x) buttons right next
  // to it, instead of relying on the person finding and clicking a nearly
  // invisible contenteditable span inside the rendered document table -
  // that span can be a couple pixels wide when the value is empty (the
  // exact case that matters most: missing fields), which is why editing
  // looked like it "wasn't working." The document pane still highlights
  // the field and its status, but the sidebar input is now the one place
  // typing actually happens.
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

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
  // results whenever the selected specification (job) changes. The actual
  // "are you sure" check for discarding unsaved edits happens at the call
  // site (selectJob below), not here - by the time this effect sees a new
  // selectedJobId the switch has already been confirmed.
  useEffect(() => {
    setActivePage(1)
    setEdits({})
    setVerifyResults(null)
    setVerifyError(null)
    setShowVerifyPanel(false)
  }, [selectedJobId])

  // Guarded setter: switching specs while there are un-saved edits (typed
  // in the document but never Approved/Saved/Rejected) would otherwise
  // silently discard them, since the effect above wipes `edits` on every
  // job change. This is the only place selectedJobId should be set from
  // user interaction.
  function selectJob(jobId: number) {
    if (jobId === selectedJobId) return
    if (Object.keys(edits).length > 0) {
      const ok = window.confirm(
        `You have ${Object.keys(edits).length} unsaved edit(s) on this specification. ` +
        `Switching will discard them unless you Approve or Save them first. Continue anyway?`,
      )
      if (!ok) return
    }
    setSelectedJobId(jobId)
  }

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
  // Static fields (is_dynamic === false) are template defaults the schema
  // explicitly allows overriding (see backend _seed_static_fields) - shown
  // in their own panel so they're editable even if the document preview's
  // auto-detected field spans don't happen to tag their placeholder.
  const staticFields = useMemo(
    () => extractedFields.filter((f) => f.is_dynamic === false),
    [extractedFields],
  )
  const [savingStaticId, setSavingStaticId] = useState<string | null>(null)

  async function handleSaveStatic(field: ExtractedFieldResponse) {
    if (!jobForSelectedDocument) return
    const value = edits[field.field_id] ?? getFieldDisplayValue(field)
    setSavingStaticId(field.field_id)
    try {
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
      setError(`Could not save static field: ${(err as Error).message}`)
    } finally {
      setSavingStaticId(null)
    }
  }
  const extractedByFieldId = useMemo(() => {
    const map: { [fieldId: string]: ExtractedFieldResponse } = {}
    for (const f of extractedFields) map[f.field_id] = f
    return map
  }, [extractedFields])

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
  // in-progress edit) and its status color. Clicking a span opens that
  // field for editing in the sidebar (see startEditingField) instead of
  // being directly contenteditable - typing straight into a table cell
  // inside the rendered document was fragile (easy to mis-click, easy to
  // break the surrounding table's layout, and the span could be visually
  // tiny for empty values). The document is now a live preview + click
  // target; the sidebar input is the one place text entry happens.
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
      span.setAttribute('style', `${STATUS_STYLE[status] || STATUS_STYLE.pending} cursor:pointer;`)
      span.removeAttribute('contenteditable')
      span.title = field ? `${field.field_label} - click to edit` : fieldId

      const handler = (e: Event) => {
        e.preventDefault()
        if (field) startEditingField(field)
      }
      span.removeEventListener('click', (span as any).__fieldClickHandler)
        ; (span as any).__fieldClickHandler = handler
      span.addEventListener('click', handler)
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
    }
  }

  function startEditingField(field: ExtractedFieldResponse) {
    setEditingFieldId(field.field_id)
    setDraftValue(edits[field.field_id] ?? getFieldDisplayValue(field))
    focusField(field.field_id)
    // autoFocus on the input covers the normal case; this covers
    // re-clicking the same row that's already rendered.
    requestAnimationFrame(() => editInputRef.current?.focus())
  }

  function cancelEditingField() {
    setEditingFieldId(null)
    setDraftValue('')
  }

  // The check button: writes the typed value straight to the field AND
  // marks it verified in one action, same as clicking a Jira title away
  // from the input commits it - there's no separate "save draft" step to
  // forget about.
  async function confirmEditingField(field: ExtractedFieldResponse) {
    if (!jobForSelectedDocument) return
    const value = draftValue
    setSavingFieldId(field.field_id)
    try {
      await updateExtractedField(jobForSelectedDocument.id, field.field_id, {
        value,
        validation_status: 'verified',
      })
      const span = docRef.current?.querySelector<HTMLElement>(`[data-field-id="${field.field_id}"]`)
      if (span) span.textContent = value
      setEdits((prev) => {
        const next = { ...prev }
        delete next[field.field_id]
        return next
      })
      setEditingFieldId(null)
      setDraftValue('')
      await loadProject()
    } catch (err) {
      setError(`Could not save edit: ${(err as Error).message}`)
    } finally {
      setSavingFieldId(null)
    }
  }

  // handleApprove and handleSaveEdit used to be separate buttons for
  // "keep as-is" vs. "save an edit" - both are now just
  // confirmEditingField above (the Jira-style check button always writes
  // the current draft, whether or not the person changed the text, and
  // always marks it verified). Removed rather than left dead so there's
  // one obvious place this logic lives, not three that can drift apart.

  // Restore this field back to what extraction originally produced,
  // discarding any edit/approve/reject that's happened since. Distinct
  // from Reject (which clears the value to blank and marks it rejected) -
  // Undo puts back the model's original output and resets status to
  // "pending" so it goes through Accept/Edit/Reject again from scratch.
  async function handleUndo(field: ExtractedFieldResponse) {
    if (!jobForSelectedDocument) return
    setSavingFieldId(field.field_id)
    try {
      await updateExtractedField(jobForSelectedDocument.id, field.field_id, {
        value: field.original_value ?? '',
        validation_status: 'pending',
      })
      setEdits((prev) => {
        const next = { ...prev }
        delete next[field.field_id]
        return next
      })
      await loadProject()
    } catch (err) {
      setError(`Could not undo field: ${(err as Error).message}`)
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

  // "GENERATE SEPARATE DOCUMENTS ... DOWNLOAD Separate Documents" from the
  // original workflow: every detected specification is its own extraction
  // job and its own file, on purpose (never a zip) - but until now there
  // was no way to get all of them without clicking into each specification
  // one at a time. Download-all just fires the existing single-file export
  // per completed job, staggered slightly so the browser doesn't treat
  // several near-simultaneous downloads as popup spam and block them.
  const completedJobCount = project?.extraction_jobs.filter((j) => j.status === 'completed').length ?? 0

  async function handleDownloadAll() {
    if (!project) return
    const completed = project.extraction_jobs.filter((j) => j.status === 'completed')
    for (let i = 0; i < completed.length; i++) {
      const job = completed[i]
      const link = document.createElement('a')
      link.href = getExtractionExportUrl(job.id, 'docx')
      link.download = ''
      document.body.appendChild(link)
      link.click()
      link.remove()
      if (i < completed.length - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 400))
      }
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
    <div className="p-8 max-w-7xl mx-auto overflow-y-auto h-full pb-20">
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
          <div className="flex items-center gap-3">
            {completedJobCount > 0 ? (
              <Button variant="secondary" onClick={() => void handleDownloadAll()}>
                <Icons.Download className="w-4 h-4" />
                Download All ({completedJobCount})
              </Button>
            ) : null}
            <Badge type={project.status}>{project.status}</Badge>
          </div>
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
                        onClick={() => selectJob(job.id)}
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

            {/* Static fields - template defaults the schema explicitly
                allows a human to override. Locked-by-default content with
                no default_value in schema never appears here at all. */}
            {staticFields.length > 0 ? (
              <Card className="p-4">
                <h3 className="font-semibold mb-1 text-sm">Static Fields</h3>
                <p className="text-xs text-slate-500 mb-3">
                  Template defaults. Locked unless you change them here.
                </p>
                <div className="space-y-3">
                  {staticFields.map((field) => {
                    const currentValue = edits[field.field_id] ?? getFieldDisplayValue(field)
                    const isDirty = currentValue !== getFieldDisplayValue(field)
                    return (
                      <div key={field.field_id}>
                        <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
                          {field.field_label}
                          <Badge type="secondary">
                            <span className="text-[10px]">🔒 static</span>
                          </Badge>
                        </label>
                        <div className="flex gap-2 mt-1">
                          <input
                            type="text"
                            className="flex-1 text-sm border border-slate-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand"
                            value={currentValue}
                            onChange={(e) =>
                              setEdits((prev) => ({ ...prev, [field.field_id]: e.target.value }))
                            }
                          />
                          <Button
                            variant="secondary"
                            className="!px-3 !py-1.5 !text-xs shrink-0"
                            disabled={!isDirty || savingStaticId === field.field_id}
                            onClick={() => void handleSaveStatic(field)}
                          >
                            {savingStaticId === field.field_id ? 'Saving…' : 'Save'}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Card>
            ) : null}

            {/* Field checklist - navigation + approve/reject only. Editing
                the value itself only ever happens in the document pane;
                nothing here is a text input. */}
            <Card className="p-4">
              <h3 className="font-semibold mb-1 text-sm">Values on This Page</h3>
              <p className="text-xs text-slate-500 mb-3">
                Edit values directly in the document, then Save (mark for review), Approve, or Reject each one here.
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
                    const verdict = verifyByFieldId[field.field_id]
                    const isEditing = editingFieldId === field.field_id
                    return (
                      <div
                        key={field.field_id}
                        className={`rounded border p-2.5 transition-colors ${isEditing ? 'border-brand ring-1 ring-brand bg-blue-50/40' : 'border-slate-200 bg-white hover:border-brand'
                          }`}
                      >
                        <div className="font-medium text-slate-900 text-xs mb-1">{field.field_label}</div>
                        {isEditing ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              ref={editInputRef}
                              autoFocus
                              type="text"
                              value={draftValue}
                              onChange={(e) => setDraftValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void confirmEditingField(field)
                                if (e.key === 'Escape') cancelEditingField()
                              }}
                              className="flex-1 text-sm border border-brand rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand"
                              placeholder="Enter a value..."
                            />
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={() => void confirmEditingField(field)}
                              className="text-green-600 hover:text-green-700 disabled:opacity-40 shrink-0"
                              title="Confirm"
                            >
                              <Icons.Check className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={cancelEditingField}
                              className="text-slate-400 hover:text-slate-600 disabled:opacity-40 shrink-0"
                              title="Cancel"
                            >
                              <Icons.X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startEditingField(field)}
                            className="w-full text-left text-xs text-slate-600 border border-dashed border-transparent hover:border-slate-300 hover:bg-slate-50 rounded px-1.5 py-1 -mx-1.5 transition-colors"
                            title="Click to edit"
                          >
                            {currentValue || <span className="italic text-slate-400">Click to add a value...</span>}
                          </button>
                        )}
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <Badge type={field.validation_status}>{field.validation_status}</Badge>
                          {verdict ? (
                            <Badge type={verifyBadgeType(verdict.status)} title={verdict.reason ?? undefined}>
                              {verifyLabel(verdict.status)}
                            </Badge>
                          ) : null}
                          {field.confidence != null ? (
                            <span className="text-[10px] text-slate-400">{Math.round(field.confidence * 100)}%</span>
                          ) : null}
                          <div className="flex-1" />
                          {!isEditing && field.original_value !== undefined &&
                            field.original_value !== null &&
                            (currentValue !== field.original_value || field.validation_status !== 'pending') ? (
                            <button
                              disabled={isSaving}
                              onClick={() => void handleUndo(field)}
                              className="text-slate-500 hover:text-slate-700 disabled:opacity-30"
                              title={`Undo back to original extracted value: "${field.original_value}"`}
                            >
                              <Icons.Undo className="w-4 h-4" />
                            </button>
                          ) : null}
                          {!isEditing ? (
                            <button
                              disabled={isSaving}
                              onClick={() => void handleReject(field)}
                              className="text-red-600 hover:text-red-700 disabled:opacity-40"
                              title="Reject and clear this value"
                            >
                              <Icons.X className="w-4 h-4" />
                            </button>
                          ) : null}
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