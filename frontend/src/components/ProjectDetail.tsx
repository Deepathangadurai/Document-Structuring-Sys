import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import { Icons } from './icons'
import { getProject, getExtractionExportUrl, verifyExtraction } from '../services/api'
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

  const docRef = useRef<HTMLDivElement>(null)

  async function loadProject() {
    const numericId = Number(projectId)
    if (!projectId || isNaN(numericId)) {
      setError('Invalid project ID.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await getProject(numericId)
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

  // Reset to page 1 and clear any stale verification results when selection changes.
  useEffect(() => {
    setActivePage(1)
    setVerifyResults(null)
    setVerifyError(null)
    setShowVerifyPanel(false)
  }, [selectedJobId])

  // Fetch the rendered page HTML for preview
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
        `Verification is not available yet: ${(err as Error).message}.`,
      )
    } finally {
      setVerifying(false)
    }
  }

  // Populate preview spans cleanly to render the final document as it will look when downloaded.
  const populatePreviewFields = useCallback(() => {
    const container = docRef.current
    if (!container) return

    // 1. Remove all editor action buttons (✓ ✏️ ✕) from the preview DOM
    const actionBars = container.querySelectorAll('.tpl-field-actions')
    actionBars.forEach((bar) => bar.remove())

    // 2. Remove all editor group classes and inline styles
    const fieldGroups = container.querySelectorAll<HTMLElement>('.tpl-field-group')
    fieldGroups.forEach((group) => {
      group.removeAttribute('style')
      group.removeAttribute('title')
      group.classList.remove('tpl-field-group', 'tpl-field-removed', 'tpl-field-kept', 'tpl-field-highlighted')
    })

    // 3. Process all field value spans to display clean text without any highlight boxes or borders
    const fieldSpans = container.querySelectorAll<HTMLElement>('[data-field-id]')
    fieldSpans.forEach((span) => {
      const fieldId = span.dataset.fieldId
      if (!fieldId) return

      // Strip all editing styles, backgrounds, outlines, dashed borders, and contenteditable
      span.removeAttribute('contenteditable')
      span.removeAttribute('style')
      span.removeAttribute('title')
      span.classList.remove('tpl-field', 'tpl-field-removed', 'tpl-field-kept', 'tpl-field-highlighted')

      const field = extractedByFieldId[fieldId]
      if (field) {
        const value = getFieldDisplayValue(field)
        // Only update text node if this element has no child nodes (e.g. inner field span)
        if (span.children.length === 0) {
          if (span.textContent !== value) {
            span.textContent = value
          }
        }
      }
    })
  }, [extractedByFieldId])

  useEffect(() => {
    populatePreviewFields()
  }, [pagePreview?.page_html, extractedByFieldId, populatePreviewFields])

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
          {/* Sidebar — Specifications list & Actions */}
          <div className="col-span-1 space-y-4">
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-50 text-sm font-bold flex items-center justify-between" style={{ color: '#1A3A6B' }}>
                <span>📋 Specifications</span>
                <span className="text-xs font-normal text-slate-500">{project.extraction_jobs.length} detected</span>
              </div>
              <ul className="divide-y divide-slate-100">
                {project.extraction_jobs.map((job: ExtractionJobResponse) => {
                  return (
                    <li key={job.id}>
                      <button
                        onClick={() => setSelectedJobId(job.id)}
                        className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                          selectedJobId === job.id ? 'bg-brand-light font-medium' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-slate-900 truncate">
                            {job.template_name ?? `Specification #${job.template_id}`}
                          </span>
                          <Badge type={job.status}>{job.status}</Badge>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-xs text-slate-500">
                            {job.template_code ?? `template #${job.template_id}`}
                          </span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Card>

            {/* Verification card */}
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

            {/* Single, central actions & export card */}
            {jobForSelectedDocument?.status === 'completed' ? (
              <Card className="p-4 space-y-3">
                <div>
                  <h3 className="font-semibold text-sm text-slate-900 mb-1">Actions &amp; Exports</h3>
                  <p className="text-xs text-slate-500">
                    Open the dedicated field editor to edit extracted values, or download document reports.
                  </p>
                </div>

                <Button
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 shadow-sm flex items-center justify-center gap-2"
                  onClick={() => navigate(`/projects/${projectId}/edit/${jobForSelectedDocument.id}`)}
                >
                  ✏️ Review &amp; Edit Fields
                </Button>

                <div className="pt-2 border-t border-slate-100 space-y-2">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">Downloads</span>
                  <a href={getExtractionExportUrl(jobForSelectedDocument.id, 'docx')} className="block">
                    <Button variant="secondary" className="w-full justify-start text-xs">
                      <Icons.Download className="w-4 h-4 mr-2" /> Download Word Document (.docx)
                    </Button>
                  </a>
                  <a href={getExtractionExportUrl(jobForSelectedDocument.id, 'pdf')} className="block">
                    <Button variant="secondary" className="w-full justify-start text-xs">
                      <Icons.Download className="w-4 h-4 mr-2" /> Download PDF Report (.pdf)
                    </Button>
                  </a>
                  <a href={getExtractionExportUrl(jobForSelectedDocument.id, 'json')} className="block">
                    <Button variant="secondary" className="w-full justify-start text-xs">
                      <Icons.Download className="w-4 h-4 mr-2" /> Download JSON (.json)
                    </Button>
                  </a>
                </div>
              </Card>
            ) : null}
          </div>

          {/* Clean Output Document Preview */}
          <div className="col-span-2">
            <Card className="overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Output Document Preview</h2>
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

                <div className="flex items-center gap-3">
                  {totalPages > 1 ? (
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-30 transition-colors"
                        disabled={activePage <= 1}
                        onClick={() => setActivePage((p) => Math.max(1, p - 1))}
                        title="Previous Page"
                      >
                        <Icons.ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="font-medium text-slate-700 px-1">
                        Page {activePage} of {totalPages}
                      </span>
                      <button
                        className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-30 transition-colors"
                        disabled={activePage >= totalPages}
                        onClick={() => setActivePage((p) => Math.min(totalPages, p + 1))}
                        title="Next Page"
                      >
                        <Icons.ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="bg-slate-100/60 p-4 flex justify-center items-start overflow-y-auto" style={{ maxHeight: 'calc(100vh - 12rem)' }}>
                {jobForSelectedDocument?.status === 'processing' || jobForSelectedDocument?.status === 'pending' ? (
                  <div className="p-8 text-center bg-white rounded-lg shadow-sm border w-full">
                    <div className="w-6 h-6 mx-auto rounded-full border-2 border-brand border-t-transparent animate-spin mb-3" />
                    <p className="text-sm text-slate-500">
                      Extracting… page {jobForSelectedDocument.current_page} of {jobForSelectedDocument.total_pages} (
                      {jobForSelectedDocument.progress}%)
                    </p>
                  </div>
                ) : !jobForSelectedDocument ? (
                  <div className="p-8 text-center bg-white rounded-lg shadow-sm border w-full">
                    <p className="text-sm text-slate-400 py-4">
                      Start an extraction for this document to see the populated output here.
                    </p>
                  </div>
                ) : previewLoading ? (
                  <div className="p-8 text-center bg-white rounded-lg shadow-sm border w-full">
                    <p className="text-sm text-slate-400 py-4">Loading document preview…</p>
                  </div>
                ) : previewError ? (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 w-full">
                    {previewError}
                  </div>
                ) : (
                  <div className="w-full bg-white shadow-md border border-slate-200 rounded p-1">
                    <img
                      key={`true-output-${jobForSelectedDocument.id}-${activePage}`}
                      src={`/api/extraction/${jobForSelectedDocument.id}/preview/page/${activePage}`}
                      alt={`Document Preview Page ${activePage}`}
                      className="w-full h-auto object-contain rounded"
                      onError={(e) => {
                        ;(e.target as HTMLElement).style.display = 'none'
                        const fallback = (e.target as HTMLElement).nextElementSibling
                        if (fallback) (fallback as HTMLElement).style.display = 'block'
                      }}
                    />
                    <div className="hidden w-full p-12 min-h-[1056px] doc-preview-paper text-slate-900 font-sans text-xs">
                      <div
                        ref={docRef}
                        dangerouslySetInnerHTML={{ __html: pagePreview?.page_html || '' }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}