import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import { Icons } from './icons'
import { getTemplate, getTemplates, listPendingTemplates, uploadTemplate } from '../services/api'
import type { TemplateField, TemplateListResponse } from '../types'

function countFields(template: TemplateListResponse): { fields: number; sections: number } {
  const sections = template.sections ?? []
  const fields = sections.reduce((sum, section) => sum + (section.fields?.length ?? 0), 0)
  return { fields, sections: sections.length }
}

export default function Templates() {
  const [templates, setTemplates] = useState<TemplateListResponse[]>([])
  const [selected, setSelected] = useState<TemplateListResponse | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPage, setPreviewPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [awaitingServer, setAwaitingServer] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const navigate = useNavigate()

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const result = await getTemplates()
      setTemplates(result)
      setSelected((prev) => prev ?? result[0] ?? null)
    } catch (err) {
      setError(`Could not load templates: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  async function loadPendingCount() {
    try {
      const pending = await listPendingTemplates()
      setPendingCount(pending.length)
    } catch {
      // Non-critical for this view - the Templates page still works without it.
    }
  }

  useEffect(() => {
    void load()
    void loadPendingCount()
  }, [])

  async function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setUploadProgress(0)
    setAwaitingServer(false)
    setUploadError(null)
    try {
      const pending = await uploadTemplate(file, (percent) => {
        setUploadProgress(percent)
        if (percent >= 100) setAwaitingServer(true)
      })
      // New uploads start as draft - take user directly to page-by-page review
      // so they can immediately validate and finalize the master template
      navigate(`/templates/pending/${pending.id}/review`)
    } catch (err) {
      setUploadError(`Could not upload template: ${(err as Error).message}`)
    } finally {
      setUploading(false)
      setUploadProgress(0)
      setAwaitingServer(false)
    }
  }

  async function handlePreview(templateId: string) {
    try {
      const fresh = await getTemplate(templateId)
      setSelected(fresh)
      setPreviewPage(0)
      setPreviewOpen(true)
    } catch (err) {
      setError(`Could not load template preview: ${(err as Error).message}`)
    }
  }

  // field_id -> field + its section name, flattened across all sections,
  // so a page's data-field-id list can be resolved to full field info in
  // one lookup instead of re-scanning selected.sections per page.
  const fieldLookup = useMemo(() => {
    const map: Record<string, { field: TemplateField; sectionName: string }> = {}
    for (const section of selected?.sections ?? []) {
      for (const field of section.fields) {
        map[field.field_id] = { field, sectionName: section.section_name }
      }
    }
    return map
  }, [selected])

  return (
    <div className="p-8 max-w-7xl mx-auto overflow-y-auto h-full pb-20">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Templates</h1>
          <p className="text-slate-500 mt-1">
            Master specifications used to structure incoming documents. Templates are read-only and define the fixed
            output shape for every project that uses them.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <input ref={fileInputRef} type="file" accept=".doc,.docx" className="hidden" onChange={handleFileChosen} />
          <Button variant="primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Icons.Upload className="w-4 h-4" />
            {!uploading
              ? 'Upload template'
              : awaitingServer
                ? 'Processing on server...'
                : `Uploading... ${uploadProgress}%`}
          </Button>
          {uploading ? (
            <div className="w-48 bg-slate-100 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-1.5 rounded-full bg-brand ${awaitingServer ? 'animate-pulse' : 'transition-all duration-150'}`}
                style={{ width: awaitingServer ? '100%' : `${uploadProgress}%` }}
              />
            </div>
          ) : null}
          {pendingCount > 0 ? (
            <Link to="/templates/pending" className="text-sm text-amber-700 hover:underline">
              {pendingCount} awaiting review &rarr;
            </Link>
          ) : null}
        </div>
      </div>

      {uploadError ? (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{uploadError}</div>
      ) : null}
      {error ? <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div> : null}

      {loading ? (
        <p className="text-sm text-slate-500">Loading templates...</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-4">
            {templates.map((t) => {
              const { fields, sections } = countFields(t)
              const isSelected = selected?.template_id === t.template_id
              return (
                <Card
                  key={t.template_id}
                  className={`p-5 cursor-pointer transition-all ${isSelected ? 'ring-2 ring-brand border-brand' : 'hover:border-slate-300'
                    }`}
                >
                  <div>
                    <div className="flex justify-between items-start mb-3">
                      <div className="text-xs font-semibold text-slate-500 bg-slate-100 px-2 py-1 rounded">
                        {t.template_id}
                      </div>
                      <div className="flex gap-2 items-center">
                        <Badge type="active">ACTIVE</Badge>
                        {t.structure_locked && (
                          <Badge type="secondary" title="Template structure is locked - only values can be edited">
                            <span className="text-xs">🔒 Locked</span>
                          </Badge>
                        )}
                      </div>
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900">{t.template_name}</h3>
                    <p className="text-sm text-slate-500 mt-2">{t.description || 'No description available.'}</p>
                    <div className="text-xs text-slate-500 mt-4 pt-3 border-t border-slate-100 flex gap-4 flex-wrap">
                      <span>Version {t.version}</span>
                      <span>{fields} fields</span>
                      <span>{sections} sections</span>
                      <span>{t.page_count ?? 1} pages</span>
                    </div>
                  </div>
                  <div className="flex gap-3 mt-4">
                    <Button
                      variant="secondary"
                      className="flex-1 flex items-center justify-center gap-2"
                      onClick={() => void handlePreview(t.template_id)}
                    >
                      <Icons.Eye className="w-4 h-4" />
                      Preview
                    </Button>
                    <Link to="/projects/new" state={{ templateId: t.template_id }} className="flex-1">
                      <Button variant="primary" className="w-full flex items-center justify-center gap-2">
                        <Icons.ArrowRight className="w-4 h-4" />
                        Use this template
                      </Button>
                    </Link>
                  </div>
                </Card>
              )
            })}
          </div>

          <div className="lg:col-span-2">
            <Card className="p-8 text-center text-sm text-slate-500">
              Select a template to use it, or click Preview to see a popup before choosing.
            </Card>
          </div>
        </div>
      )}

      {previewOpen && selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-2xl border border-slate-200">
            <button
              type="button"
              onClick={() => setPreviewOpen(false)}
              className="absolute right-4 top-4 text-slate-500 hover:text-slate-800 text-2xl leading-none"
              aria-label="Close preview"
            >
              ×
            </button>

            <div className="p-6 pr-12">
              <h2 className="text-xl font-semibold text-slate-900">{selected.template_name}</h2>
              <p className="text-sm text-slate-500 mt-1">{selected.description}</p>
              <p className="text-sm text-slate-500 mt-2">
                <strong>Version:</strong> {selected.version}
                {selected.specification_number ? (
                  <>
                    {' '}
                    &middot; <strong>Spec No.</strong> {selected.specification_number}
                  </>
                ) : null}
                <span className="ml-2">&middot; <strong>{selected.page_count ?? 1}</strong> pages</span>
              </p>

              <div className="mt-6 border border-slate-200 rounded-md bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Template preview</p>
                {selected.page_html && selected.page_html.length > 0 ? (
                  // One page at a time: the current page's rendered content,
                  // with only the dynamic fields tagged on that page below
                  // it (matched via the same data-field-id spans the
                  // extraction-review screen uses) - plus prev/next to move
                  // through the rest of the document.
                  (() => {
                    const pages = selected.page_html!
                    const pageIdx = Math.min(previewPage, pages.length - 1)
                    const html = pages[pageIdx]
                    const ids = new Set<string>()
                    const regex = /data-field-id="([^"]+)"/g
                    let m: RegExpExecArray | null
                    while ((m = regex.exec(html))) ids.add(m[1])
                    const fieldsOnThisPage = Array.from(ids)
                      .map((id) => fieldLookup[id])
                      .filter(Boolean) as { field: TemplateField; sectionName: string }[]
                    const imagePath = selected.page_images?.[pageIdx]

                    return (
                      <div className="border border-slate-200 rounded-md bg-white overflow-hidden">
                        <div className="px-4 py-2 bg-slate-100 border-b border-slate-200 flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}
                            disabled={pageIdx <= 0}
                            className="px-2 py-1 text-xs font-semibold text-slate-600 rounded hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            &larr; Prev
                          </button>
                          <span className="text-xs font-semibold text-slate-500">
                            Page {pageIdx + 1} of {pages.length}
                          </span>
                          <button
                            type="button"
                            onClick={() => setPreviewPage((p) => Math.min(pages.length - 1, p + 1))}
                            disabled={pageIdx >= pages.length - 1}
                            className="px-2 py-1 text-xs font-semibold text-slate-600 rounded hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            Next &rarr;
                          </button>
                        </div>

                        {imagePath ? (
                          <div className="bg-slate-900 flex justify-center py-4">
                            <img
                              src={imagePath}
                              alt={`Preview of ${selected.template_name} page ${pageIdx + 1}`}
                              style={{ maxWidth: '100%', height: 'auto', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}
                              className="border border-slate-300"
                            />
                          </div>
                        ) : (
                          <div
                            className="p-4 text-sm leading-6 max-h-[420px] overflow-auto"
                            dangerouslySetInnerHTML={{ __html: html }}
                          />
                        )}

                        <div className="p-4 border-t border-slate-200">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                            Dynamic values on this page
                          </p>
                          {fieldsOnThisPage.length > 0 ? (
                            <ul className="space-y-1.5">
                              {fieldsOnThisPage.map(({ field, sectionName }) => {
                                const isDynamic = field.is_dynamic !== false
                                return (
                                  <li key={field.field_id} className="flex items-center justify-between text-sm gap-2">
                                    <span className="text-slate-700 flex-1">
                                      {field.field_label}
                                      <span className="text-slate-400 text-xs ml-1">({sectionName})</span>
                                    </span>
                                    <span className="flex items-center gap-1.5">
                                      <span
                                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${isDynamic
                                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                                            : 'bg-slate-100 text-slate-500 border-slate-200'
                                          }`}
                                        title={isDynamic ? 'Dynamic — extracted from source document' : 'Static — fixed boilerplate text'}
                                      >
                                        <span className={`w-1.5 h-1.5 rounded-full inline-block ${isDynamic ? 'bg-blue-500' : 'bg-slate-400'}`} />
                                        {isDynamic ? 'Dynamic' : 'Static'}
                                      </span>
                                      <span className={field.required ? 'text-slate-500 text-xs' : 'text-slate-400 text-xs'}>
                                        {field.required ? 'required' : 'optional'}
                                      </span>
                                    </span>
                                  </li>
                                )
                              })}
                            </ul>
                          ) : (
                            <p className="text-xs text-slate-400">No dynamic fields tagged on this page.</p>
                          )}
                        </div>
                      </div>
                    )
                  })()
                ) : selected.page_images && selected.page_images.length > 0 ? (
                  // No page_html to derive per-page fields from - fall back
                  // to one page image at a time with the full field list below.
                  (() => {
                    const images = selected.page_images!
                    const pageIdx = Math.min(previewPage, images.length - 1)
                    return (
                      <div className="border border-slate-200 rounded-md bg-white overflow-hidden">
                        <div className="px-4 py-2 bg-slate-100 border-b border-slate-200 flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}
                            disabled={pageIdx <= 0}
                            className="px-2 py-1 text-xs font-semibold text-slate-600 rounded hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            &larr; Prev
                          </button>
                          <span className="text-xs font-semibold text-slate-500">
                            Page {pageIdx + 1} of {images.length}
                          </span>
                          <button
                            type="button"
                            onClick={() => setPreviewPage((p) => Math.min(images.length - 1, p + 1))}
                            disabled={pageIdx >= images.length - 1}
                            className="px-2 py-1 text-xs font-semibold text-slate-600 rounded hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            Next &rarr;
                          </button>
                        </div>
                        <div className="bg-slate-900 flex justify-center py-4">
                          <img
                            src={images[pageIdx]}
                            alt={`Preview of ${selected.template_name} page ${pageIdx + 1}`}
                            style={{ maxWidth: '100%', height: 'auto', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}
                            className="border border-slate-300"
                          />
                        </div>
                      </div>
                    )
                  })()
                ) : selected.preview_html ? (
                  <div
                    className="max-h-[420px] overflow-auto border border-slate-200 bg-white p-4 rounded-md text-sm leading-6"
                    dangerouslySetInnerHTML={{ __html: selected.preview_html }}
                  />
                ) : (
                  <div className="text-sm text-slate-500">No preview available for this template yet.</div>
                )}
              </div>

              {/* Full field list (all pages combined) - only needed as a
                  fallback when page_html isn't available to derive the
                  per-page breakdown above. */}
              {!(selected.page_html && selected.page_html.length > 0) && (
                <div className="mt-6 space-y-6">
                  {(selected.sections ?? []).map((section) => (
                    <div key={section.section_id}>
                      <h3 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-2 mb-3 uppercase tracking-wide">
                        {section.section_name}
                      </h3>
                      <ul className="space-y-1.5">
                        {section.fields.map((field) => {
                          const isDynamic = field.is_dynamic !== false
                          return (
                            <li key={field.field_id} className="flex items-center justify-between text-sm gap-2">
                              <span className="text-slate-700 flex-1">{field.field_label}</span>
                              <span className="flex items-center gap-1.5">
                                <span
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${isDynamic
                                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                                      : 'bg-slate-100 text-slate-500 border-slate-200'
                                    }`}
                                  title={isDynamic ? 'Dynamic — extracted from source document' : 'Static — fixed boilerplate text'}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full inline-block ${isDynamic ? 'bg-blue-500' : 'bg-slate-400'}`} />
                                  {isDynamic ? 'Dynamic' : 'Static'}
                                </span>
                                <span className={field.required ? 'text-slate-500 text-xs' : 'text-slate-400 text-xs'}>
                                  {field.required ? 'required' : 'optional'}
                                </span>
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}