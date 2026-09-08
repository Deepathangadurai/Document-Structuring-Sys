/**
 * ProjectDetail — Engineering Project & Document Structuring Dashboard
 *
 * Route: /projects/:projectId
 *
 * Features:
 * - Horizontal Command Bar at the top:
 *     • Specifications selector pills (switch between extracted specifications)
 *     • "Review & Update" button (smoothly scrolls to the embedded document editor on the same page)
 *     • "Preview Document" button (opens dedicated preview modal on-demand, not always shown)
 *     • "Verify Document / Re-verify" button (runs verification against template requirements)
 *     • Horizontal Downloads: Word (.docx), PDF (.pdf), JSON (.json)
 *     • Horizontal Verification Verdicts Strip (MATCH, MISMATCH, NOT FOUND, REVIEW)
 * - Same-page "Review & Update" Editor (embedded JiraFieldEditor, NO redirection to new page!):
 *     • Complete document structure
 *     • Cover page card with 3x3 document header grid
 *     • Paragraphs, tables, and editable fields with live save and verified badges
 *     • Filter by All, Missing, Review, Verified
 * - Dedicated Document Preview Modal with page navigation, zoom, and quick download
 * - Uses Lucide icons throughout
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Eye,
  FileEdit,
  ShieldCheck,
  Download,
  FileText,
  FileCode,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  X,
  Layers,
  Info,
  RotateCcw,
  ScrollText,
  Square,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Badge, Button, Card } from './ui'
import { getProject, getExtractionExportUrl, verifyExtraction } from '../services/api'
import JiraFieldEditor from './JiraFieldEditor'
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

  // Dedicated preview modal state (preview as separate button, not always shown)
  const [showPreviewModal, setShowPreviewModal] = useState(false)
  const [previewTimestamp, setPreviewTimestamp] = useState<number>(Date.now())
  const [totalPdfPages, setTotalPdfPages] = useState<number>(1)
  const [previewMode, setPreviewMode] = useState<'scroll' | 'paged'>('scroll')
  const [zoomLevel, setZoomLevel] = useState<number>(100)
  const previewScrollContainerRef = useRef<HTMLDivElement>(null)

  // Verification state
  const [verifyResults, setVerifyResults] = useState<FieldVerificationResponse[] | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

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
  }, [projectId])

  // Poll while any job is still processing
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
  }, [project])

  const selectedJob: ExtractionJobResponse | null = useMemo(() => {
    if (!project || !selectedJobId) return null
    return project.extraction_jobs.find((j) => j.id === selectedJobId) ?? null
  }, [project, selectedJobId])
  const jobForSelectedDocument = selectedJob

  // Reset page and verification state when selected job changes
  useEffect(() => {
    setActivePage(1)
    setVerifyResults(null)
    setVerifyError(null)
  }, [selectedJobId])

  // Fetch page preview HTML / metadata when modal is active or activePage changes
  useEffect(() => {
    if (!jobForSelectedDocument || !showPreviewModal) {
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
  }, [jobForSelectedDocument, activePage, showPreviewModal])

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
    try {
      const results = await verifyExtraction(jobForSelectedDocument.id)
      setVerifyResults(results)
    } catch (err) {
      setVerifyError(`Verification failed: ${(err as Error).message}`)
    } finally {
      setVerifying(false)
    }
  }

  // Populate preview spans cleanly to render the final document in preview modal
  const populatePreviewFields = useCallback(() => {
    const container = docRef.current
    if (!container) return

    const actionBars = container.querySelectorAll('.tpl-field-actions')
    actionBars.forEach((bar) => bar.remove())

    const fieldGroups = container.querySelectorAll<HTMLElement>('.tpl-field-group')
    fieldGroups.forEach((group) => {
      group.removeAttribute('style')
      group.removeAttribute('title')
      group.classList.remove('tpl-field-group', 'tpl-field-removed', 'tpl-field-kept', 'tpl-field-highlighted')
    })

    const fieldSpans = container.querySelectorAll<HTMLElement>('[data-field-id]')
    fieldSpans.forEach((span) => {
      const fieldId = span.dataset.fieldId
      if (!fieldId) return

      span.removeAttribute('contenteditable')
      span.removeAttribute('style')
      span.removeAttribute('title')
      span.classList.remove('tpl-field', 'tpl-field-removed', 'tpl-field-kept', 'tpl-field-highlighted')

      const field = extractedByFieldId[fieldId]
      if (field) {
        const value = getFieldDisplayValue(field)
        if (span.children.length === 0 && span.textContent !== value) {
          span.textContent = value
        }
      }
    })
  }, [extractedByFieldId])

  useEffect(() => {
    populatePreviewFields()
  }, [pagePreview?.page_html, extractedByFieldId, populatePreviewFields])

  useEffect(() => {
    if (!jobForSelectedDocument || !showPreviewModal) return
    let active = true
    fetch(`/api/extraction/${jobForSelectedDocument.id}/preview/info`)
      .then(res => res.json())
      .then(data => {
        if (active && data?.total_pages) {
          setTotalPdfPages(data.total_pages)
        }
      })
      .catch(() => {})
    return () => { active = false }
  }, [jobForSelectedDocument, showPreviewModal, previewTimestamp])

  // Keyboard navigation and smooth scroll for preview modal
  const totalPages = totalPdfPages || pagePreview?.total_pages || 1

  const scrollToPage = useCallback((pageNum: number) => {
    setActivePage(pageNum)
    if (previewMode === 'scroll') {
      const el = document.getElementById(`doc-preview-page-${pageNum}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  }, [previewMode])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowPreviewModal(false)
      if (showPreviewModal) {
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault()
          scrollToPage(Math.max(1, activePage - 1))
        }
        if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          e.preventDefault()
          scrollToPage(Math.min(totalPages, activePage + 1))
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showPreviewModal, totalPages, activePage, scrollToPage])

  // Track active page as user scrolls through pages in scroll mode
  useEffect(() => {
    if (!showPreviewModal || previewMode !== 'scroll') return
    const container = previewScrollContainerRef.current
    if (!container) return

    let timeoutId: number
    const handleScroll = () => {
      window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => {
        const pageCards = container.querySelectorAll<HTMLElement>('[data-page-num]')
        if (pageCards.length === 0) return

        const containerRect = container.getBoundingClientRect()
        const targetLine = containerRect.top + 160

        let closestPage = activePage
        let minDistance = Infinity

        pageCards.forEach((card) => {
          const rect = card.getBoundingClientRect()
          const dist = Math.abs(rect.top - targetLine)
          if (dist < minDistance) {
            minDistance = dist
            const num = Number(card.getAttribute('data-page-num'))
            if (num) closestPage = num
          }
        })

        if (closestPage !== activePage) {
          setActivePage(closestPage)
        }
      }, 50)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.clearTimeout(timeoutId)
      container.removeEventListener('scroll', handleScroll)
    }
  }, [showPreviewModal, previewMode, activePage])

  const scrollToEditor = () => {
    const el = document.getElementById('review-and-update-editor')
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  if (loading && !project) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-8">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm font-semibold text-slate-600">Loading project details…</p>
        </div>
      </div>
    )
  }

  if (error && !project) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="p-6 bg-red-50 border border-red-200 rounded-2xl text-sm text-red-800 space-y-3">
          <div className="font-bold flex items-center gap-2">
            <XCircle className="w-5 h-5 text-red-600" />
            Unable to load project
          </div>
          <p>{error}</p>
          <Button variant="secondary" onClick={() => navigate('/projects')}>
            ← Back to Projects
          </Button>
        </div>
      </div>
    )
  }

  if (!project) return null

  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans pb-28">
      {/* ── Top Navigation Bar ── */}
      <div className="border-b border-slate-200 bg-white shadow-2xs">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/projects')}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-colors flex items-center gap-1.5"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Back to Projects</span>
            </button>
            <div className="h-5 w-px bg-slate-200" />
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-bold text-slate-900">{project.project_name}</h1>
                <Badge type={project.status}>{project.status}</Badge>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {project.extraction_jobs.length} specification
                {project.extraction_jobs.length === 1 ? '' : 's'} detected from source document
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 pt-6 space-y-6">
        {/* ── HORIZONTAL COMMAND & FEATURE BAR (ALL FEATURES IN HORIZONTAL LINE AT TOP) ── */}
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-5 space-y-4">
          {/* Row 1: Specifications Selector Pills (Horizontal) */}
          {project.extraction_jobs.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap pb-3 border-b border-slate-100">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-slate-400" />
                Specifications:
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                {project.extraction_jobs.map((job: ExtractionJobResponse) => {
                  const isSelected = selectedJobId === job.id
                  return (
                    <button
                      key={job.id}
                      onClick={() => setSelectedJobId(job.id)}
                      className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all ${
                        isSelected
                          ? 'bg-blue-50 text-blue-700 border-2 border-blue-600 shadow-xs'
                          : 'bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200'
                      }`}
                    >
                      <span className="font-bold">
                        {job.template_name ?? `Specification #${job.template_id}`}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                          job.status === 'completed'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {job.status}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Row 2: All Action Features in One Clean Horizontal Line */}
          {jobForSelectedDocument && (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              {/* Left group: Review & Update, Preview, Verification */}
              <div className="flex items-center gap-2.5 flex-wrap">
                {/* 1. Review & Update Button (Stays on same page, scrolls directly into the editor) */}
                <button
                  onClick={scrollToEditor}
                  className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold rounded-xl shadow-xs hover:shadow-md flex items-center gap-2 text-xs transition-all tracking-wide"
                  title="Review and update document structure on this page"
                >
                  <FileEdit className="w-4 h-4" />
                  <span>Review &amp; Update</span>
                </button>

                {/* 2. Preview Document Button (Separate button, opens preview modal on-demand) */}
                <button
                  onClick={() => {
                    setPreviewTimestamp(Date.now())
                    setShowPreviewModal(true)
                  }}
                  className="px-4 py-2.5 bg-white hover:bg-slate-50 text-slate-700 font-semibold border border-slate-300 rounded-xl shadow-xs hover:shadow flex items-center gap-2 text-xs transition-all"
                  title="Open Output Document Preview modal"
                >
                  <Eye className="w-4 h-4 text-slate-600" />
                  <span>Preview Document</span>
                </button>

                {/* 3. Verify Document / Re-verify Button */}
                <button
                  onClick={() => void handleVerify()}
                  disabled={verifying}
                  className="px-4 py-2.5 bg-white hover:bg-slate-50 text-slate-700 font-semibold border border-slate-300 rounded-xl shadow-xs hover:shadow flex items-center gap-2 text-xs transition-all disabled:opacity-50"
                >
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  <span>
                    {verifying ? 'Verifying…' : verifyResults ? 'Re-verify' : 'Verify Document'}
                  </span>
                </button>
              </div>

              {/* Right group: Downloads (Word, PDF, JSON) in horizontal line */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-slate-400 mr-1 hidden sm:inline">Downloads:</span>
                <a
                  href={getExtractionExportUrl(jobForSelectedDocument.id, 'docx')}
                  download
                  className="px-3 py-2 bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold border border-slate-200 rounded-xl shadow-xs hover:shadow flex items-center gap-1.5 text-xs transition-all"
                  title="Download Word Document (.docx)"
                >
                  <FileText className="w-3.5 h-3.5 text-blue-600" />
                  <span>Word (.docx)</span>
                </a>
                <a
                  href={getExtractionExportUrl(jobForSelectedDocument.id, 'pdf')}
                  download
                  className="px-3 py-2 bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold border border-slate-200 rounded-xl shadow-xs hover:shadow flex items-center gap-1.5 text-xs transition-all"
                  title="Download PDF Report (.pdf)"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-600" />
                  <span>PDF (.pdf)</span>
                </a>
                <a
                  href={getExtractionExportUrl(jobForSelectedDocument.id, 'json')}
                  download
                  className="px-3 py-2 bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold border border-slate-200 rounded-xl shadow-xs hover:shadow flex items-center gap-1.5 text-xs transition-all"
                  title="Download JSON (.json)"
                >
                  <FileCode className="w-3.5 h-3.5 text-amber-600" />
                  <span>JSON</span>
                </a>
              </div>
            </div>
          )}
        </div>

        {/* ── SAME-PAGE REVIEW & UPDATE: FULL DOCUMENT STRUCTURE EDITOR (NO REDIRECTION!) ── */}
        <div id="review-and-update-editor" className="w-full">
          {jobForSelectedDocument ? (
            <JiraFieldEditor
              key={`embedded-spec-editor-${jobForSelectedDocument.id}`}
              embedded={true}
              jobId={jobForSelectedDocument.id}
              projectId={project.id}
            />
          ) : (
            <Card className="p-8 text-center text-sm text-slate-500">
              Select a specification above to review and update document structure.
            </Card>
          )}
        </div>
      </div>

      {/* ── DEDICATED DOCUMENT PREVIEW MODAL ── */}
      {showPreviewModal && jobForSelectedDocument && (
        <div
          className="fixed inset-0 bg-slate-900/80 backdrop-blur-xs z-50 flex flex-col items-center justify-center p-2 sm:p-4 md:p-6 animate-in fade-in duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowPreviewModal(false)
          }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl h-[94vh] flex flex-col overflow-hidden border border-slate-300">
            {/* Modal Header */}
            <div className="px-5 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50/90">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 shadow-2xs">
                  <Eye className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    Document Output Preview
                  </h2>
                  <p className="text-[11px] text-slate-500 font-medium">
                    {jobForSelectedDocument.template_name ?? 'Specification'} · Job #{jobForSelectedDocument.id}
                  </p>
                </div>
              </div>

              {/* Center Controls: Page Navigation & Mode Toggle */}
              <div className="flex items-center gap-2">
                {/* Page Navigator */}
                {totalPages > 1 && (
                  <div className="flex items-center gap-1 bg-white px-2 py-1 rounded-xl border border-slate-200 shadow-2xs">
                    <button
                      className="p-1 rounded-lg hover:bg-slate-100 disabled:opacity-30 transition-colors text-slate-700"
                      disabled={activePage <= 1}
                      onClick={() => scrollToPage(Math.max(1, activePage - 1))}
                      title="Previous Page (Left Arrow)"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <select
                      value={activePage}
                      onChange={(e) => scrollToPage(Number(e.target.value))}
                      className="text-xs font-bold text-slate-800 bg-transparent py-0.5 px-1 border-0 focus:ring-0 cursor-pointer text-center"
                    >
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                        <option key={p} value={p}>
                          Page {p} of {totalPages}
                        </option>
                      ))}
                    </select>
                    <button
                      className="p-1 rounded-lg hover:bg-slate-100 disabled:opacity-30 transition-colors text-slate-700"
                      disabled={activePage >= totalPages}
                      onClick={() => scrollToPage(Math.min(totalPages, activePage + 1))}
                      title="Next Page (Right Arrow)"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* View Mode Toggle: Continuous Scroll vs Single Page */}
                <div className="flex items-center bg-slate-200/80 p-1 rounded-xl border border-slate-300">
                  <button
                    type="button"
                    onClick={() => setPreviewMode('scroll')}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                      previewMode === 'scroll'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-700 hover:text-slate-900 hover:bg-slate-200/50'
                    }`}
                    title="Continuous Vertical Scroll (All Pages)"
                  >
                    <ScrollText className="w-3.5 h-3.5" />
                    <span>Scroll Mode</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewMode('paged')}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                      previewMode === 'paged'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-700 hover:text-slate-900'
                    }`}
                    title="Single Page View"
                  >
                    <Square className="w-3.5 h-3.5" />
                    <span>Single Page</span>
                  </button>
                </div>

                {/* Zoom Controls */}
                <div className="hidden sm:flex items-center gap-1 bg-white px-2 py-1 rounded-xl border border-slate-200 shadow-2xs">
                  <button
                    onClick={() => setZoomLevel((z) => Math.max(60, z - 15))}
                    disabled={zoomLevel <= 60}
                    className="p-1 rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"
                    title="Zoom Out"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[11px] font-bold text-slate-700 min-w-[38px] text-center">
                    {zoomLevel}%
                  </span>
                  <button
                    onClick={() => setZoomLevel((z) => Math.min(140, z + 15))}
                    disabled={zoomLevel >= 140}
                    className="p-1 rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"
                    title="Zoom In"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Right Modal Actions */}
              <div className="flex items-center gap-2">
                <a
                  href={getExtractionExportUrl(jobForSelectedDocument.id, 'docx')}
                  download
                  className="px-2.5 py-1.5 bg-white hover:bg-slate-100 text-slate-700 font-semibold border border-slate-200 rounded-lg text-xs transition-colors flex items-center gap-1 shadow-2xs"
                >
                  <FileText className="w-3.5 h-3.5 text-blue-600" />
                  <span>DOCX</span>
                </a>
                <a
                  href={getExtractionExportUrl(jobForSelectedDocument.id, 'pdf')}
                  download
                  className="px-2.5 py-1.5 bg-white hover:bg-slate-100 text-slate-700 font-semibold border border-slate-200 rounded-lg text-xs transition-colors flex items-center gap-1 shadow-2xs"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-600" />
                  <span>PDF</span>
                </a>
                <button
                  onClick={() => setPreviewTimestamp(Date.now())}
                  className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-500 hover:text-slate-800 transition-colors"
                  title="Refresh Preview"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowPreviewModal(false)}
                  className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-500 hover:text-slate-800 transition-colors"
                  title="Close Preview (Esc)"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body: Continuous Scroll or Single Page Render */}
            <div
              ref={previewScrollContainerRef}
              className="flex-1 overflow-auto bg-slate-200/75 p-6 flex flex-col items-center space-y-6 scroll-smooth"
            >
              {previewLoading && previewMode === 'paged' ? (
                <div className="p-12 text-center bg-white rounded-2xl shadow-sm border border-slate-200 w-full max-w-lg m-auto">
                  <div className="w-8 h-8 mx-auto rounded-full border-3 border-blue-600 border-t-transparent animate-spin mb-3" />
                  <p className="text-xs font-semibold text-slate-600">Loading document preview…</p>
                </div>
              ) : previewError ? (
                <div className="p-6 bg-red-50 border border-red-200 rounded-2xl text-xs text-red-800 max-w-lg m-auto">
                  {previewError}
                </div>
              ) : previewMode === 'scroll' ? (
                /* Continuous Multi-Page Scroll View */
                Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
                  <div
                    key={`doc-page-card-${pageNum}-${previewTimestamp}`}
                    id={`doc-preview-page-${pageNum}`}
                    data-page-num={pageNum}
                    className="w-full bg-white shadow-2xl border border-slate-300 rounded-xl overflow-hidden transition-all duration-150 flex flex-col"
                    style={{
                      maxWidth: `${Math.round(850 * (zoomLevel / 100))}px`,
                    }}
                  >
                    {/* Top page badge */}
                    <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600 font-semibold select-none">
                      <span className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            activePage === pageNum ? 'bg-blue-600 ring-4 ring-blue-100' : 'bg-slate-400'
                          }`}
                        />
                        Page {pageNum} of {totalPages}
                      </span>
                      <span className="text-[11px] text-slate-400 font-normal">
                        {jobForSelectedDocument.template_name ?? 'Specification'}
                      </span>
                    </div>

                    {/* Page Image */}
                    <div className="p-3 bg-white flex justify-center items-center min-h-[500px]">
                      <img
                        loading="lazy"
                        src={`/api/extraction/${jobForSelectedDocument.id}/preview/page/${pageNum}?t=${previewTimestamp}`}
                        alt={`Document Page ${pageNum}`}
                        className="w-full h-auto object-contain rounded"
                        onError={(e) => {
                          ;(e.target as HTMLElement).style.display = 'none'
                          const fallback = (e.target as HTMLElement).nextElementSibling
                          if (fallback) (fallback as HTMLElement).style.display = 'block'
                        }}
                      />
                      <div className="hidden w-full p-12 min-h-[800px] doc-preview-paper text-slate-900 font-sans text-xs">
                        <div
                          dangerouslySetInnerHTML={{ __html: pagePreview?.page_html || '' }}
                        />
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                /* Single Page View */
                <div
                  className="w-full bg-white shadow-2xl border border-slate-300 rounded-xl overflow-hidden p-2"
                  style={{
                    maxWidth: `${Math.round(850 * (zoomLevel / 100))}px`,
                  }}
                >
                  <img
                    key={`modal-output-${jobForSelectedDocument.id}-${activePage}-${previewTimestamp}`}
                    src={`/api/extraction/${jobForSelectedDocument.id}/preview/page/${activePage}?t=${previewTimestamp}`}
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

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-slate-200 bg-white flex items-center justify-between text-xs">
              <span className="text-slate-500 font-medium">
                Scroll with mouse wheel / touchpad to view next pages continuously, or use Arrow keys / Page Up / Page Down.
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setShowPreviewModal(false)
                    scrollToEditor()
                  }}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-xs transition-colors flex items-center gap-1.5"
                >
                  <FileEdit className="w-3.5 h-3.5" />
                  <span>Jump to Editor</span>
                </button>
                <button
                  onClick={() => setShowPreviewModal(false)}
                  className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}