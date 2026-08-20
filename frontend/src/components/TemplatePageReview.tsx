import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import type { PendingTemplateResponse } from '../types'

interface PageAnalysisState {
  page_number: number
  total_pages: number
  page_image_url: string
  page_html: string
  fields: any[]
  sections_on_page: any[]
  structure_summary: string
  validation_status: 'pending' | 'validated' | 'needs_review'
  user_validated: boolean
}

interface DeterministicExtraction {
  field_labels: string[]
  table_count: number
  layout_score: number
  line_count: number
}

interface PageFidelity {
  coverage_ratio: number
  table_match_ratio: number
  page_coverage: {
    covered_tokens: number
    total_tokens: number
    coverage_ratio: number
  }
}

interface ValidationResult {
  page_number: number
  validated_fields: any[]
  suggestions: string[]
  needs_user_review: boolean
  model_response?: string
  error?: string
  deterministic_extraction?: DeterministicExtraction
  page_fidelity?: PageFidelity
}

interface PageFeedback {
  page_number: number
  corrections: { [key: string]: string }
  approved_fields: string[]
  removed_fields: string[]
  notes: string
}

function buildPageTextFromHtml(html: string, fields: any[] = []) {
  if (!html) {
    return (fields || [])
      .map((field) => {
        const label = field.field_label || field.label || field.field_name || field.name || 'Unknown field'
        const value = field.value ?? field.field_value ?? field.default_value ?? ''
        const normalizedValue = typeof value === 'string' ? value.trim() : value
        return normalizedValue ? `${label}: ${normalizedValue}` : label
      })
      .join('\n')
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const contentBlocks: string[] = []

  doc.body.querySelectorAll('table, p, h1, h2, h3, h4, li').forEach((node) => {
    const text = node.textContent?.replace(/\s+/g, ' ').trim()
    if (!text) return

    if (node.tagName === 'TABLE') {
      const rows = Array.from(node.querySelectorAll('tr')).map((row) => {
        const cells = Array.from(row.querySelectorAll('td, th'))
          .map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
        return cells.length ? cells.join(' | ') : ''
      }).filter(Boolean)

      if (rows.length) {
        contentBlocks.push(rows.join('\n'))
      }
      return
    }

    contentBlocks.push(text)
  })

  const fieldText = (fields || [])
    .map((field) => {
      const label = field.field_label || field.label || field.field_name || field.name || 'Unknown field'
      const value = field.value ?? field.field_value ?? field.default_value ?? ''
      const normalizedValue = typeof value === 'string' ? value.trim() : value
      return normalizedValue ? `${label}: ${normalizedValue}` : label
    })
    .join('\n')

  return [...contentBlocks, fieldText].filter(Boolean).join('\n\n')
}

function getFieldDisplayLabel(field: any) {
  return field?.field_label || field?.label || field?.field_name || field?.name || 'Field'
}

function getFieldDisplayValue(field: any, fallbackValue = '') {
  const rawValue = field?.value ?? field?.field_value ?? field?.default_value ?? fallbackValue
  return typeof rawValue === 'string' ? rawValue.trim() : rawValue ?? ''
}

export default function TemplatePageReview() {
  const { templateId } = useParams<{ templateId: string }>()
  const navigate = useNavigate()

  const [template, setTemplate] = useState<PendingTemplateResponse | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [pageAnalysis, setPageAnalysis] = useState<PageAnalysisState | null>(null)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [validating, setValidating] = useState(false)
  const [pageDecision, setPageDecision] = useState<'pending' | 'approved' | 'rejected'>('pending')

  const [pageFeedback, setPageFeedback] = useState<PageFeedback>({
    page_number: currentPage,
    corrections: {},
    approved_fields: [],
    removed_fields: [],
    notes: '',
  })

  const [allPagesApproved, setAllPagesApproved] = useState<{ [key: number]: boolean }>({})

  // The rendered document itself is the edit surface: the backend tags
  // each detected field's value with a <span data-field-id="..."
  // contenteditable="true"> directly in the page HTML (see
  // schema_inference.py's _render_table/_render_paragraph). This ref
  // lets us read/write those spans in place instead of guessing where a
  // value sits by matching label text after the fact.
  const docRef = useRef<HTMLDivElement>(null)

  // Wire up the tagged spans whenever the page's HTML is (re)rendered.
  // Typing into a span writes straight into pageFeedback.corrections
  // keyed by field_id - the same corrections object the side panel and
  // the save/finalize calls already use, so nothing downstream needs to
  // change to consume it.
  const bindEditableFields = useCallback((fields: any[], feedback: PageFeedback) => {
    const container = docRef.current
    if (!container) return

    const corrections = feedback.corrections
    const spans = container.querySelectorAll<HTMLElement>('[data-field-id].tpl-field')
    spans.forEach((span) => {
      const fieldId = span.dataset.fieldId
      if (!fieldId) return

      const group = container.querySelector<HTMLElement>(`.tpl-field-group[data-field-id="${fieldId}"]`)
      const isRemoved = feedback.removed_fields.includes(fieldId)
      const isKept = feedback.approved_fields.includes(fieldId)

      // A page revisited after editing should show the edited value,
      // not the original sample - restore it once, then let the DOM be
      // the source of truth until the next full HTML swap. A removed
      // field stays visually blank/struck-through instead.
      const stored = corrections[fieldId]
      if (isRemoved) {
        if (!span.dataset.originalValue) span.dataset.originalValue = span.textContent || ''
        span.textContent = ''
      } else if (stored !== undefined && span.textContent !== stored) {
        span.textContent = stored
      }
      group?.classList.toggle('tpl-field-removed', isRemoved)
      group?.classList.toggle('tpl-field-kept', isKept && !isRemoved)

      const handler = () => {
        const text = (span.textContent || '').trim()
        setPageFeedback((prev) => ({
          ...prev,
          corrections: { ...prev.corrections, [fieldId]: text },
        }))
      }
      // Avoid stacking duplicate listeners across re-renders.
      span.removeEventListener('input', (span as any).__fieldInputHandler)
      ;(span as any).__fieldInputHandler = handler
      span.addEventListener('input', handler)
    })
  }, [])

  useEffect(() => {
    bindEditableFields(pageAnalysis?.fields || [], pageFeedback)
    // Only re-bind when the underlying HTML actually changes (new page,
    // freshly loaded) - not on every keystroke, or we'd fight the
    // browser's own cursor/selection handling inside the editable spans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageAnalysis?.page_html])

  // Handle clicks on the inline keep/edit/remove controls rendered next
  // to each tagged field (see backend schema_inference.py _tag_close).
  // Delegated on the document container - a page can have 100+ tagged
  // fields, so binding a listener per button isn't worth it, and the
  // container survives across the HTML being swapped on page change.
  const handleFieldAction = useCallback((action: string, fieldId: string) => {
    const container = docRef.current
    if (!container) return
    const group = container.querySelector<HTMLElement>(`.tpl-field-group[data-field-id="${fieldId}"]`)
    const span = container.querySelector<HTMLElement>(`.tpl-field[data-field-id="${fieldId}"]`)
    if (!group || !span) return

    if (action === 'remove') {
      if (!span.dataset.originalValue) {
        span.dataset.originalValue = span.textContent || ''
      }
      span.textContent = ''
      group.classList.add('tpl-field-removed')
      group.classList.remove('tpl-field-kept')
      setPageFeedback((prev) => ({
        ...prev,
        corrections: { ...prev.corrections, [fieldId]: '' },
        approved_fields: prev.approved_fields.filter((id) => id !== fieldId),
        removed_fields: prev.removed_fields.includes(fieldId)
          ? prev.removed_fields
          : [...prev.removed_fields, fieldId],
      }))
      return
    }

    if (action === 'keep') {
      // Keeping a previously-removed field restores its original value
      // rather than approving an empty one.
      if (group.classList.contains('tpl-field-removed') && span.dataset.originalValue) {
        span.textContent = span.dataset.originalValue
      }
      group.classList.remove('tpl-field-removed')
      group.classList.add('tpl-field-kept')
      const text = (span.textContent || '').trim()
      setPageFeedback((prev) => ({
        ...prev,
        corrections: { ...prev.corrections, [fieldId]: text },
        approved_fields: prev.approved_fields.includes(fieldId)
          ? prev.approved_fields
          : [...prev.approved_fields, fieldId],
        removed_fields: prev.removed_fields.filter((id) => id !== fieldId),
      }))
      return
    }

    if (action === 'edit') {
      if (group.classList.contains('tpl-field-removed') && span.dataset.originalValue) {
        span.textContent = span.dataset.originalValue
      }
      group.classList.remove('tpl-field-removed')
      setPageFeedback((prev) => ({
        ...prev,
        removed_fields: prev.removed_fields.filter((id) => id !== fieldId),
      }))
      span.focus()
      const range = document.createRange()
      range.selectNodeContents(span)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [])

  useEffect(() => {
    const container = docRef.current
    if (!container) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const button = target.closest<HTMLElement>('[data-action]')
      if (!button || !container.contains(button)) return
      e.preventDefault()
      const action = button.dataset.action
      const fieldId = button.dataset.fieldId
      if (action && fieldId) handleFieldAction(action, fieldId)
    }
    container.addEventListener('click', onClick)
    return () => container.removeEventListener('click', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageAnalysis?.page_html, handleFieldAction])

  const focusField = (fieldId: string) => {
    // .tpl-field-group, .tpl-field, and .tpl-field-actions all carry
    // data-field-id (see backend _tag_open/_tag_close) - scope to the
    // actual editable span, or this grabs the outer wrapper instead and
    // .focus()/selectNodeContents silently no-op on it.
    const el = docRef.current?.querySelector<HTMLElement>(`.tpl-field[data-field-id="${fieldId}"]`)
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

  // Load template on mount
  useEffect(() => {
    async function loadTemplate() {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch(`/api/templates/pending/${templateId}`, { cache: 'no-store' })
        if (!response.ok) throw new Error('Failed to load template')
        const data = await response.json()
        setTemplate(data)
      } catch (err) {
        setError(`Failed to load template: ${(err as Error).message}`)
      } finally {
        setLoading(false)
      }
    }
    loadTemplate()
  }, [templateId])

  // Load and analyze current page
  useEffect(() => {
    async function analyzePage() {
      if (!template) return

      setAnalyzing(true)
      try {
        const response = await fetch(
          `/api/templates/pending/${templateId}/pages/${currentPage}/preview`,
          { cache: 'no-store' }
        )

        const pageFields: any[] = []
        const pageSections: any[] = []

        const analysis: PageAnalysisState = {
          page_number: currentPage,
          total_pages: Math.max(template.page_images?.length || template.page_html?.length || 1, 1),
          page_image_url: template.page_images?.[currentPage - 1] || '',
          page_html: template.page_html?.[currentPage - 1] || '',
          fields: pageFields,
          sections_on_page: pageSections,
          structure_summary: `Page ${currentPage}: no fields detected yet`,
          validation_status: allPagesApproved[currentPage] ? 'validated' : 'pending',
          user_validated: false,
        }

        if (!response.ok) {
          setPageAnalysis(analysis)
          setValidationResult(null)
          return
        }

        const preview = await response.json()
        if (preview?.page_image_url) {
          analysis.page_image_url = preview.page_image_url
        }
        if (preview?.page_html) {
          analysis.page_html = preview.page_html
          analysis.page_image_url = ''
        }
        if (preview?.total_pages) {
          analysis.total_pages = preview.total_pages
        }
        const previewFields = Array.isArray(preview?.fields_on_page) ? preview.fields_on_page : []
        const previewSections = Array.isArray(preview?.sections_on_page) ? preview.sections_on_page : []

        analysis.fields = previewFields
        analysis.sections_on_page = previewSections
        analysis.structure_summary = previewFields.length
          ? `Page ${currentPage}: ${previewFields.length} fields detected`
          : `Page ${currentPage}: no fields detected on this page`

        setPageAnalysis(analysis)
        setValidationResult(null)
      } catch (err) {
        setError(`Failed to analyze page: ${(err as Error).message}`)
      } finally {
        setAnalyzing(false)
      }
    }

    analyzePage()
  }, [currentPage, template, templateId, allPagesApproved])

  // Validate current page with Ollama
  const handleValidatePage = async () => {
    if (!pageAnalysis) return

    setValidating(true)
    try {
      const fieldsWithCorrections = (pageAnalysis.fields || []).map((field) => {
        const key = field.field_id || field.field_label || field.label || field.field_name || field.name || ''
        const correction = pageFeedback.corrections[key]
        if (correction && String(correction).trim()) {
          return {
            ...field,
            value: String(correction).trim(),
          }
        }
        return field
      })

      const pageText = buildPageTextFromHtml(pageAnalysis.page_html || '', fieldsWithCorrections)

      const response = await fetch(
        `/api/templates/pending/${templateId}/pages/${currentPage}/validate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            page_number: currentPage,
            page_text: pageText,
            extracted_fields: pageAnalysis.fields,
          }),
        }
      )
      if (!response.ok) throw new Error('Validation failed')
      const result = await response.json()
      setValidationResult(result)
    } catch (err) {
      setError(`Validation error: ${(err as Error).message}`)
    } finally {
      setValidating(false)
    }
  }

  // Submit page feedback
  const handleSubmitPageFeedback = async (decision: 'approved' | 'rejected' = 'approved') => {
    try {
      const payload = {
        ...pageFeedback,
        page_number: currentPage,
        approved_fields: decision === 'approved' ? pageFeedback.approved_fields : [],
      }

      const response = await fetch(
        `/api/templates/pending/${templateId}/pages/${currentPage}/feedback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify(payload),
        }
      )
      if (!response.ok) throw new Error('Failed to submit feedback')

      setPageDecision(decision)
      if (decision === 'approved') {
        setAllPagesApproved(prev => ({ ...prev, [currentPage]: true }))
      } else {
        setAllPagesApproved(prev => ({ ...prev, [currentPage]: false }))
      }

      if (pageAnalysis && currentPage < pageAnalysis.total_pages) {
        setCurrentPage(currentPage + 1)
      }
    } catch (err) {
      setError(`Failed to submit feedback: ${(err as Error).message}`)
    }
  }

  // Finalize master template
  const handleFinalizeMasterTemplate = async () => {
    if (!template) return

    try {
      // Prepare final schema
      const finalSchema = {
        ...template,
        status: 'approved',
        validated_at: new Date().toISOString(),
      }

      const validationSummary = {
        total_pages_validated: pageAnalysis?.total_pages || 1,
        total_fields_extracted: template.sections?.flatMap(s => s.fields).length || 0,
        average_confidence: 0.85,
      }

      const response = await fetch(
        `/api/templates/pending/${templateId}/finalize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            final_schema: finalSchema,
            validation_summary: validationSummary,
          }),
        }
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.detail || 'Failed to finalize template')
      }

      // Finalizing activates the template as a master template in the
      // library (see finalize_master_template) - it's no longer "pending",
      // so send the user to the library where it now actually lives.
      navigate('/templates', { state: { success: 'Template saved as master template' } })
    } catch (err) {
      setError(`Finalization error: ${(err as Error).message}`)
    }
  }

  if (loading) return <div className="p-8">Loading template...</div>
  if (error) return <div className="p-8 text-red-600">{error}</div>
  if (!template || !pageAnalysis) return <div className="p-8">No template data</div>

  const isLastPage = currentPage === pageAnalysis.total_pages
  const pageProgress = ((currentPage) / pageAnalysis.total_pages) * 100

  return (
    <div className="p-8 max-w-6xl mx-auto overflow-y-auto h-full pb-20">
      {/* Header */}
      <div className="mb-8">
        <Link to="/templates/pending" className="text-sm text-brand hover:underline">
          &larr; Back to Pending Templates
        </Link>
        <div className="flex items-center justify-between mt-2">
          <h1 className="text-2xl font-semibold text-slate-900">{template.template_name}</h1>
          <Badge type="info">Page {currentPage} of {pageAnalysis.total_pages}</Badge>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mb-8">
        <div className="flex justify-between text-sm text-slate-600 mb-2">
          <span>Template Review Progress</span>
          <span>{Math.round(pageProgress)}%</span>
        </div>
        <div className="w-full bg-slate-200 rounded-full h-2">
          <div
            className="bg-brand h-2 rounded-full transition-all"
            style={{ width: `${pageProgress}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Page Image Section */}
        <div className="lg:col-span-2">
          <Card className="p-6">
            <h2 className="text-lg font-semibold mb-4">Page {currentPage} Preview</h2>
            <div className="bg-slate-100 rounded-lg p-4 mb-4 min-h-96">
              {pageAnalysis.page_html ? (
                <div>
                  <div className="text-xs text-slate-500 mb-2">
                    This <em>is</em> the document. Highlighted values are editable — click and type to change one, or hover it to keep (✓), edit (✎), or remove (✕) it; everything else stays locked to the source layout.
                  </div>
                  {/* Horizontal scroll fallback: table-layout:fixed + word-break
                      in the generated HTML keeps columns within the page
                      width, but on very narrow (mobile) viewports there's
                      still not enough room to keep every column readable at
                      a usable font size. Scrolling beats silently clipping
                      the right-most column off the edge.
                      min-width matches a real printed page's content width
                      (~8.5in at 96dpi) - the previous 680px was narrow
                      enough that a 6-column table (revision history) had no
                      room left for its last column or two, which is what
                      was clipping "DATE" and truncating "SHT. 1 OF 20". */}
                  <div style={{ width: '100%', overflowX: 'auto' }}>
                    <div
                      ref={docRef}
                      className="bg-white rounded shadow-sm p-6 text-sm text-slate-900 max-w-none border border-slate-200"
                      style={{
                        width: '100%',
                        minWidth: '816px',
                        minHeight: '1056px',
                        fontFamily: 'Arial, sans-serif',
                      }}
                      dangerouslySetInnerHTML={{ __html: pageAnalysis.page_html }}
                    />
                  </div>
                </div>
              ) : pageAnalysis.page_image_url ? (
                <img
                  src={pageAnalysis.page_image_url}
                  alt={`Page ${currentPage}`}
                  className="w-full h-auto rounded"
                />
              ) : (
                <div className="text-slate-500 text-center py-8">Page image not available</div>
              )}
            </div>

            {/* Structure Summary */}
            <div className="bg-brand-light border border-brand/20 rounded p-4 mb-4">
              <h3 className="font-semibold text-brand mb-2">Structure Detected</h3>
              <p className="text-brand text-sm">{pageAnalysis.structure_summary}</p>
            </div>

            {/* Validation Result */}
            {validationResult && (
              <>
                <div className={`rounded p-4 mb-4 ${
                  validationResult.needs_user_review
                    ? 'bg-yellow-50 border border-yellow-200'
                    : 'bg-green-50 border border-green-200'
                }`}>
                  <h3 className="font-semibold mb-2">
                    {validationResult.needs_user_review ? '⚠️ Review Required' : '✓ Validation Complete'}
                  </h3>
                  <p className="text-sm mb-3">{validationResult.model_response}</p>

                  {validationResult.suggestions && validationResult.suggestions.length > 0 && (
                    <div className="text-sm">
                      <p className="font-semibold mb-1">Suggestions:</p>
                      <ul className="list-disc list-inside space-y-1">
                        {validationResult.suggestions.map((suggestion, idx) => (
                          <li key={idx} className="text-slate-700">{suggestion}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {validationResult.error && (
                    <p className="text-red-600 text-sm">{validationResult.error}</p>
                  )}
                </div>

                {/* Deterministic Extraction Data */}
                {validationResult.deterministic_extraction && (
                  <div className="rounded p-4 mb-4 bg-purple-50 border border-purple-200">
                    <h3 className="font-semibold text-purple-900 mb-2">📊 Page Structure Analysis</h3>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-purple-700 font-medium">Fields Detected</p>
                        <p className="text-2xl font-bold text-purple-600">{validationResult.deterministic_extraction.field_labels.length}</p>
                      </div>
                      <div>
                        <p className="text-purple-700 font-medium">Tables</p>
                        <p className="text-2xl font-bold text-purple-600">{validationResult.deterministic_extraction.table_count}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-purple-700 font-medium mb-1">Layout Score</p>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-purple-200 rounded-full h-2">
                            <div
                              className="bg-purple-600 h-2 rounded-full"
                              style={{ width: `${validationResult.deterministic_extraction.layout_score * 100}%` }}
                            />
                          </div>
                          <span className="text-purple-600 font-semibold w-12 text-right">
                            {(validationResult.deterministic_extraction.layout_score * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="text-xs text-purple-600 mt-1">{validationResult.deterministic_extraction.line_count} content lines</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Page Fidelity Comparison */}
                {validationResult.page_fidelity && (
                  <div className="rounded p-4 mb-4 bg-accent-light border border-accent/30">
                    <h3 className="font-semibold text-accent mb-2">🎯 Source Fidelity</h3>
                    <div className="space-y-3 text-sm">
                      <div>
                        <p className="text-accent font-medium mb-1">Content Coverage</p>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-accent-light rounded-full h-2">
                            <div
                              className="bg-accent h-2 rounded-full"
                              style={{ width: `${validationResult.page_fidelity.coverage_ratio * 100}%` }}
                            />
                          </div>
                          <span className="text-accent font-semibold w-12 text-right">
                            {(validationResult.page_fidelity.coverage_ratio * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="text-xs text-accent mt-1">
                          {validationResult.page_fidelity.page_coverage.covered_tokens} of {validationResult.page_fidelity.page_coverage.total_tokens} tokens matched
                        </p>
                      </div>
                      <div>
                        <p className="text-accent font-medium mb-1">Table Structure Match</p>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-accent-light rounded-full h-2">
                            <div
                              className="bg-accent h-2 rounded-full"
                              style={{ width: `${validationResult.page_fidelity.table_match_ratio * 100}%` }}
                            />
                          </div>
                          <span className="text-accent font-semibold w-12 text-right">
                            {(validationResult.page_fidelity.table_match_ratio * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="text-xs text-accent mt-1">Deterministic table row matching</p>
                      </div>
                    </div>
                    {validationResult.page_fidelity.coverage_ratio >= 0.8 && validationResult.page_fidelity.table_match_ratio >= 0.7 ? (
                      <p className="text-xs text-green-700 mt-2 font-semibold">✓ High fidelity extraction</p>
                    ) : (
                      <p className="text-xs text-amber-700 mt-2 font-semibold">⚠ Check extracted content against source</p>
                    )}
                  </div>
                )}
              </>
            )}
          </Card>
        </div>

        {/* Fields Panel - jump-to index only. Keeping, editing, and removing
            a value all happen inline in the document on the left (see the
            tpl-field-actions buttons next to each highlighted value) - this
            panel just lists what's on the page and lets you click through
            to it; it is not where the edit itself happens. */}
        <div className="lg:col-span-1">
          <Card className="p-6">
            <h3 className="font-semibold mb-1">Values on This Page</h3>
            <p className="text-xs text-slate-500 mb-4">
              This is just an index. Use the ✓ keep / ✎ edit / ✕ remove buttons next to each highlighted value in the document itself to review it.
            </p>

            {pageAnalysis.fields.length === 0 ? (
              <p className="text-slate-500 text-sm">No editable values detected on this page.</p>
            ) : (
              <div className="overflow-y-auto max-h-96 border border-slate-200 rounded bg-slate-50 p-3 space-y-2">
                {pageAnalysis.fields.map((field, idx) => {
                  const fieldKey = field.field_id || `${getFieldDisplayLabel(field)}-${idx}`
                  const currentValue = getFieldDisplayValue(field, pageFeedback.corrections[fieldKey] ?? field.default_value ?? '')
                  const isApproved = pageFeedback.approved_fields.includes(fieldKey)
                  const isRemoved = pageFeedback.removed_fields.includes(fieldKey)

                  return (
                    <button
                      key={fieldKey}
                      type="button"
                      onClick={() => focusField(fieldKey)}
                      className={`w-full text-left rounded border p-3 transition-colors ${
                        isRemoved
                          ? 'border-red-200 bg-red-50 hover:border-red-300'
                          : isApproved
                          ? 'border-green-200 bg-green-50 hover:border-green-300'
                          : 'border-slate-200 bg-white hover:border-brand hover:bg-brand-light'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium text-slate-900 text-sm">
                          {getFieldDisplayLabel(field)}
                        </div>
                        {isRemoved && <span className="text-[10px] font-semibold text-red-600">REMOVED</span>}
                        {!isRemoved && isApproved && <span className="text-[10px] font-semibold text-green-600">KEPT</span>}
                      </div>
                      <div className={`text-xs mt-1 truncate ${isRemoved ? 'text-red-400 line-through' : 'text-slate-600'}`}>
                        {isRemoved ? 'removed' : currentValue || <span className="italic text-slate-400">empty — click to fill in</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            <div className="mt-2 text-xs text-slate-500">
              {pageAnalysis.fields.length} values • {pageFeedback.approved_fields.length} kept • {pageFeedback.removed_fields.length} removed
            </div>
          </Card>

          {/* Action Buttons */}
          <div className="space-y-2 mt-4">
            <Button
              className="w-full bg-brand hover:bg-brand-dark"
              onClick={handleValidatePage}
              disabled={validating}
            >
              {validating ? 'Validating...' : 'Validate with Ollama'}
            </Button>

            <Button
              className="w-full bg-green-600 hover:bg-green-700"
              onClick={async () => {
                // Record this last page's own approval first, then finalize -
                // otherwise the final page's feedback never gets saved and
                // "Approve & Finalize" silently did neither for it.
                await handleSubmitPageFeedback('approved')
                if (isLastPage) {
                  await handleFinalizeMasterTemplate()
                }
              }}
            >
              {isLastPage ? 'Approve & Finalize' : 'Approve & Next Page'}
            </Button>

            <Button
              className="w-full bg-red-600 hover:bg-red-700"
              onClick={() => handleSubmitPageFeedback('rejected')}
            >
              {isLastPage ? 'Reject This Page' : 'Reject & Next Page'}
            </Button>

            {!isLastPage && (
              <Button
                className="w-full"
                variant="secondary"
                onClick={() => setCurrentPage(currentPage + 1)}
              >
                Skip to Next Page
              </Button>
            )}
          </div>

          {/* Notes Section */}
          <Card className="p-4 mt-4">
            <h4 className="font-semibold text-sm mb-2">Notes</h4>
            <textarea
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-brand"
              rows={3}
              placeholder="Add notes for this page..."
              value={pageFeedback.notes}
              onChange={(e) => {
                setPageFeedback(prev => ({
                  ...prev,
                  notes: e.target.value,
                }))
              }}
            />
          </Card>
        </div>
      </div>

      {/* Navigation Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-4">
        <div className="max-w-6xl mx-auto flex justify-between">
          <Button
            variant="secondary"
            onClick={() => currentPage > 1 && setCurrentPage(currentPage - 1)}
            disabled={currentPage === 1}
          >
            ← Previous Page
          </Button>

          {isLastPage && (
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={async () => {
                await handleSubmitPageFeedback('approved')
                await handleFinalizeMasterTemplate()
              }}
            >
              Finalize Master Template
            </Button>
          )}

          <Button
            onClick={() => currentPage < pageAnalysis.total_pages && setCurrentPage(currentPage + 1)}
            disabled={isLastPage}
          >
            Next Page →
          </Button>
        </div>
      </div>
    </div>
  )
}