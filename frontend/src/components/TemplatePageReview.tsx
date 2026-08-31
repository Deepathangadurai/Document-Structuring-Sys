import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import type { PendingTemplateResponse } from '../types'

/* ─────────────────────────────────────────────────────────
   Types
───────────────────────────────────────────────────────── */
interface PageField {
  field_id: string
  field_label: string
  value?: string
  default_value?: string
  page_number?: number
  clause_ref?: string        // e.g. "2.2.1" or "cover"
  extraction_hint?: string   // how the AI will find this in a project doc
  required?: boolean
  data_type?: string
}



/* ─────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────── */
function label(f: PageField) {
  return (f as any).field_label || (f as any).label || (f as any).field_name || 'Field'
}

function value(f: PageField) {
  const v = (f as any).value ?? (f as any).field_value ?? (f as any).default_value ?? ''
  return typeof v === 'string' ? v.trim() : String(v ?? '')
}

/* ─────────────────────────────────────────────────────────
   Main component
───────────────────────────────────────────────────────── */
export default function TemplatePageReview() {
  const { templateId } = useParams<{ templateId: string }>()
  const navigate = useNavigate()

  const [template, setTemplate] = useState<PendingTemplateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Per-page preview data (fields on that page)
  const [pageFields, setPageFields] = useState<Record<number, PageField[]>>({})
  const [loadingPages, setLoadingPages] = useState<Set<number>>(new Set())

  // Which page is "active" in the right panel
  const [activePage, setActivePage] = useState(1)

  // User corrections: fieldId → new value
  const [corrections, setCorrections] = useState<Record<string, string>>({})
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const [removed, setRemoved] = useState<Set<string>>(new Set())

  // Page approval tracking
  const [approvedPages, setApprovedPages] = useState<Set<number>>(new Set())

  // Refs for page scroll-spy
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const containerRef = useRef<HTMLDivElement>(null)

  /* ── Load template ── */
  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/templates/pending/${templateId}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('Failed to load template')
        const data: PendingTemplateResponse = await res.json()
        setTemplate(data)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [templateId])

  /* ── Lazy-load per-page field data ── */
  const loadPageFields = useCallback(async (pageNum: number) => {
    if (pageFields[pageNum] || loadingPages.has(pageNum)) return
    setLoadingPages(prev => new Set([...prev, pageNum]))
    try {
      const res = await fetch(`/api/templates/pending/${templateId}/pages/${pageNum}/preview`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        const fields: PageField[] = Array.isArray(data?.fields_on_page) ? data.fields_on_page : []
        setPageFields(prev => ({ ...prev, [pageNum]: fields }))
      } else {
        setPageFields(prev => ({ ...prev, [pageNum]: [] }))
      }
    } catch {
      setPageFields(prev => ({ ...prev, [pageNum]: [] }))
    } finally {
      setLoadingPages(prev => { const s = new Set(prev); s.delete(pageNum); return s })
    }
  }, [templateId, pageFields, loadingPages])

  /* ── Intersection observer: load fields and set active page as pages scroll into view ── */
  useEffect(() => {
    if (!template) return
    const totalPages = template.page_images?.length || template.page_html?.length || template.page_count || 1
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          const pageNum = Number((entry.target as HTMLElement).dataset.page)
          if (entry.isIntersecting) {
            setActivePage(pageNum)
            loadPageFields(pageNum)
          }
        })
      },
      { root: containerRef.current, rootMargin: '-10% 0px -60% 0px', threshold: 0 }
    )
    Object.values(pageRefs.current).forEach(el => el && observer.observe(el))
    // Pre-load page 1
    loadPageFields(1)
    return () => observer.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template])

  /* ── Scroll to a page ── */
  function scrollToPage(pageNum: number) {
    pageRefs.current[pageNum]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /* ── Field actions ── */
  function toggleRemove(fieldId: string, currentValue: string) {
    setRemoved(prev => {
      const next = new Set(prev)
      if (next.has(fieldId)) {
        next.delete(fieldId)
      } else {
        next.add(fieldId)
        setApproved(a => { const na = new Set(a); na.delete(fieldId); return na })
        setCorrections(c => ({ ...c, [fieldId]: '' }))
      }
      return next
    })
    if (!removed.has(fieldId)) {
      setCorrections(c => ({ ...c, [fieldId]: '' }))
    } else {
      // restore
      setCorrections(c => ({ ...c, [fieldId]: currentValue }))
    }
  }

  function toggleApprove(fieldId: string, currentValue: string) {
    setApproved(prev => {
      const next = new Set(prev)
      if (next.has(fieldId)) {
        next.delete(fieldId)
      } else {
        next.add(fieldId)
        setRemoved(r => { const nr = new Set(r); nr.delete(fieldId); return nr })
        if (!corrections[fieldId]) {
          setCorrections(c => ({ ...c, [fieldId]: currentValue }))
        }
      }
      return next
    })
  }

  /* ── Approve a page and submit feedback ── */
  async function approvePage(pageNum: number) {
    const fields = pageFields[pageNum] || []
    const corrObj: Record<string, string> = {}
    const approvedList: string[] = []
    const removedList: string[] = []
    fields.forEach(f => {
      const fid = f.field_id
      if (removed.has(fid)) { removedList.push(fid); corrObj[fid] = '' }
      else if (approved.has(fid)) { approvedList.push(fid); corrObj[fid] = corrections[fid] ?? value(f) }
      else { corrObj[fid] = corrections[fid] ?? value(f) }
    })
    try {
      await fetch(`/api/templates/pending/${templateId}/pages/${pageNum}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_number: pageNum, corrections: corrObj, approved_fields: approvedList, notes: '' }),
      })
      setApprovedPages(prev => new Set([...prev, pageNum]))
    } catch { /* ignore */ }
  }

  /* ── Finalize ── */
  async function handleFinalize() {
    if (!template) return
    const totalPages = template.page_images?.length || template.page_html?.length || template.page_count || 1
    // Approve any unapproved pages silently
    for (let p = 1; p <= totalPages; p++) {
      if (!approvedPages.has(p)) await approvePage(p)
    }
    try {
      const res = await fetch(`/api/templates/pending/${templateId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          final_schema: { ...template, status: 'approved' },
          validation_summary: { total_pages_validated: totalPages, total_fields_extracted: template.sections?.flatMap(s => s.fields).length || 0 },
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.detail || 'Finalization failed')
      }
      navigate('/templates', { state: { success: 'Template saved as master template' } })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /* ─────────────── Render ─────────────── */
  if (loading) return <div className="p-8 text-sm text-slate-500">Loading template…</div>
  if (error) return <div className="p-8 text-red-600">{error}</div>
  if (!template) return <div className="p-8">No template data</div>

  const pageImages = template.page_images || []
  const pageHtml = template.page_html || []
  const totalPages = Math.max(pageImages.length, pageHtml.length, template.page_count || 1, 1)
  const allApproved = approvedPages.size === totalPages

  const activeFields = pageFields[activePage] || []
  const isLoadingActive = loadingPages.has(activePage)

  return (
    <div className="flex h-full overflow-hidden" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>

      {/* ══════════════════════════════════════════════
          LEFT RAIL: page thumbnails / navigation
      ══════════════════════════════════════════════ */}
      <aside className="w-20 shrink-0 bg-slate-900 flex flex-col items-center py-4 gap-2 overflow-y-auto">
        <span className="text-[10px] text-slate-500 mb-1 uppercase tracking-widest">Pages</span>
        {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
          <button
            key={p}
            onClick={() => scrollToPage(p)}
            title={`Page ${p}`}
            className={`relative w-12 rounded-sm overflow-hidden border-2 transition-all shrink-0 ${
              activePage === p
                ? 'border-blue-400 shadow-[0_0_0_2px_rgba(96,165,250,0.4)]'
                : approvedPages.has(p)
                ? 'border-green-500/60 opacity-80 hover:opacity-100'
                : 'border-transparent opacity-60 hover:opacity-90 hover:border-slate-500'
            }`}
          >
            {pageImages[p - 1] ? (
              <img src={pageImages[p - 1]} alt={`Page ${p}`} className="w-full h-auto block" loading="lazy" />
            ) : (
              <div className="bg-white aspect-[3/4] flex items-center justify-center text-[8px] text-slate-400">{p}</div>
            )}
            {approvedPages.has(p) && (
              <span className="absolute top-0.5 right-0.5 w-3 h-3 bg-green-500 rounded-full text-[6px] text-white flex items-center justify-center">✓</span>
            )}
            <span className="absolute bottom-0 left-0 right-0 text-center text-[7px] text-white bg-black/50 py-px">{p}</span>
          </button>
        ))}
      </aside>

      {/* ══════════════════════════════════════════════
          CENTRE: scrollable multi-page document view
      ══════════════════════════════════════════════ */}
      <main
        ref={containerRef}
        className="flex-1 overflow-y-auto bg-slate-200 px-6 py-6 space-y-8"
      >
        {/* Header */}
        <div className="bg-white rounded-xl shadow-sm px-6 py-4 flex items-center justify-between">
          <div>
            <Link to="/templates/pending" className="text-xs text-blue-600 hover:underline">← Back to Pending</Link>
            <h1 className="text-lg font-semibold text-slate-900 mt-1">{template.template_name}</h1>
            <p className="text-xs text-slate-500">
              {totalPages} page{totalPages !== 1 ? 's' : ''} · {template.sections?.length ?? 0} sections ·{' '}
              {template.sections?.reduce((s, sec) => s + sec.fields.length, 0) ?? 0} fields
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge type="draft">DRAFT</Badge>
            {allApproved && (
              <Button className="bg-green-600 hover:bg-green-700 text-sm py-2 px-4" onClick={handleFinalize}>
                ✓ Save as Master Template
              </Button>
            )}
          </div>
        </div>

        {/* Pages */}
        {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => {
          const imgSrc = pageImages[p - 1]
          const html = pageHtml[p - 1]
          const isApproved = approvedPages.has(p)

          return (
            <div
              key={p}
              ref={el => { pageRefs.current[p] = el }}
              data-page={p}
              className={`bg-white rounded-xl shadow-md overflow-hidden transition-all ${
                activePage === p ? 'ring-2 ring-blue-400' : ''
              } ${isApproved ? 'ring-2 ring-green-400' : ''}`}
            >
              {/* Page header strip */}
              <div className={`flex items-center justify-between px-5 py-2 border-b text-xs font-medium ${
                isApproved ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-50 border-slate-200 text-slate-600'
              }`}>
                <span>Page {p} of {totalPages}</span>
                <div className="flex items-center gap-2">
                  {isApproved
                    ? <span className="text-green-600 font-semibold">✓ Approved</span>
                    : (
                      <button
                        onClick={() => approvePage(p)}
                        className="px-3 py-1 bg-green-500 hover:bg-green-600 text-white rounded text-xs font-medium transition-colors"
                      >
                        Approve Page
                      </button>
                    )
                  }
                </div>
              </div>

              {/* Page content: prefer image (pixel-perfect), fall back to HTML */}
              <div className="overflow-x-auto">
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={`Page ${p}`}
                    className="w-full h-auto block"
                    style={{ minWidth: '600px' }}
                    loading={p <= 3 ? 'eager' : 'lazy'}
                  />
                ) : html ? (
                  <div
                    className="p-8 text-sm text-slate-900"
                    style={{
                      minWidth: '816px',
                      minHeight: '1056px',
                      fontFamily: 'Arial, sans-serif',
                    }}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                ) : (
                  <div className="h-48 flex items-center justify-center text-slate-400 text-sm">
                    Page {p} preview not available
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {/* Bottom finalize bar */}
        <div className="bg-white rounded-xl shadow-sm px-6 py-4 flex items-center justify-between">
          <p className="text-sm text-slate-600">
            {approvedPages.size} of {totalPages} pages approved
          </p>
          <Button
            className={`text-sm py-2 px-6 ${allApproved ? 'bg-green-600 hover:bg-green-700' : 'bg-slate-300 text-slate-500 cursor-not-allowed'}`}
            onClick={allApproved ? handleFinalize : undefined}
            disabled={!allApproved}
          >
            {allApproved ? '✓ Save as Master Template' : `Approve all ${totalPages} pages to finalize`}
          </Button>
        </div>
      </main>

      {/* ══════════════════════════════════════════════
          RIGHT PANEL: fields on active page
      ══════════════════════════════════════════════ */}
      <aside className="w-72 shrink-0 bg-white border-l border-slate-200 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Page {activePage} Fields</h3>
            {activeFields.length > 0 && (
              <span className="text-[10px] bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
                {activeFields.length} values
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {isLoadingActive ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : activeFields.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6 italic">
              {pageFields[activePage] === undefined ? 'Scroll to load fields…' : 'No fields detected on this page.'}
            </p>
          ) : (
            activeFields.map((field, idx) => {
              const fid = field.field_id || `field-${idx}`
              const original = value(field)
              const isRemoved = removed.has(fid)
              const isApproved = approved.has(fid)
              const current = corrections[fid] ?? original
              const clause = (field as any).clause_ref

              return (
                <div
                  key={fid}
                  className={`relative rounded-lg border p-3 transition-all ${
                    isRemoved
                      ? 'border-red-200 bg-red-50'
                      : isApproved
                      ? 'border-green-200 bg-green-50'
                      : 'border-slate-200 bg-white hover:border-blue-300 hover:shadow-sm'
                  }`}
                >

                  <div className="flex items-start justify-between gap-1 mb-1.5">
                    <div className="flex-1 min-w-0">
                      <span className={`text-xs font-medium leading-tight block ${
                        isRemoved ? 'text-red-500 line-through' : 'text-slate-700'
                      }`}>
                        {label(field)}
                      </span>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {/* Keep / Approve */}
                      <button
                        title="Mark as kept"
                        onClick={() => toggleApprove(fid, current)}
                        className={`w-5 h-5 rounded text-[10px] font-bold transition-colors flex items-center justify-center ${
                          isApproved && !isRemoved
                            ? 'bg-green-500 text-white'
                            : 'bg-slate-100 text-slate-400 hover:bg-green-100 hover:text-green-600'
                        }`}
                      >
                        ✓
                      </button>
                      {/* Remove */}
                      <button
                        title="Remove this field"
                        onClick={() => toggleRemove(fid, current)}
                        className={`w-5 h-5 rounded text-[10px] font-bold transition-colors flex items-center justify-center ${
                          isRemoved
                            ? 'bg-red-500 text-white'
                            : 'bg-slate-100 text-slate-400 hover:bg-red-100 hover:text-red-600'
                        }`}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {!isRemoved && (
                    <input
                      className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                      value={current}
                      placeholder="(empty — will be extracted per project)"
                      onChange={e => setCorrections(c => ({ ...c, [fid]: e.target.value }))}
                    />
                  )}

                  {isRemoved && (
                    <button
                      className="text-[10px] text-red-500 hover:text-red-700 mt-1"
                      onClick={() => toggleRemove(fid, original)}
                    >
                      Undo remove
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Approve this page button */}
        <div className="px-3 py-3 border-t border-slate-100 bg-slate-50">
          {approvedPages.has(activePage) ? (
            <div className="text-center text-xs text-green-600 font-semibold py-1">✓ Page {activePage} approved</div>
          ) : (
            <button
              onClick={() => approvePage(activePage)}
              className="w-full py-2 bg-green-500 hover:bg-green-600 text-white text-xs font-semibold rounded-lg transition-colors"
            >
              Approve Page {activePage}
            </button>
          )}
          <div className="text-[10px] text-center text-slate-400 mt-1">
            {approvedPages.size}/{totalPages} pages approved
          </div>
        </div>
      </aside>
    </div>
  )
}