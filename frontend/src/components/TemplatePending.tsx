import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import { listPendingTemplates, rejectPendingTemplate } from '../services/api'
import type { PendingTemplateResponse } from '../types'

function countFields(template: PendingTemplateResponse): { fields: number; sections: number } {
  const sections = template.sections ?? []
  const fields = sections.reduce((sum, section) => sum + (section.fields?.length ?? 0), 0)
  return { fields, sections: sections.length }
}

export default function TemplatePending() {
  const navigate = useNavigate()
  const [pending, setPending] = useState<PendingTemplateResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await listPendingTemplates()
        if (!cancelled) setPending(result)
      } catch (err) {
        if (!cancelled) setError(`Could not load pending templates: ${(err as Error).message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const handlePageByPageReview = (templateId: number) => {
    navigate(`/templates/pending/${templateId}/review`)
  }

  const handlePreview = (templateId: number) => {
    navigate(`/templates/pending/${templateId}`)
  }

  const handleRemovePending = async (templateId: number) => {
    const target = pending.find((item) => item.id === templateId)
    if (!target) return

    const confirmed = window.confirm(`Remove the pending template "${target.template_name}"? This cannot be undone.`)
    if (!confirmed) return

    try {
      await rejectPendingTemplate(templateId)
      setPending((prev) => prev.filter((item) => item.id !== templateId))
    } catch (err) {
      setError(`Could not remove pending template: ${(err as Error).message}`)
    }
  }

  return (
    <div className="p-8 max-w-5xl mx-auto overflow-y-auto h-full pb-20">
      <div className="mb-8">
        <Link to="/templates" className="text-sm text-blue-600 hover:underline">
          &larr; Back to Templates
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Pending review</h1>
        <p className="text-slate-500 mt-1">
          Uploaded specifications that have been auto-parsed into a draft field list. Review page-by-page and
          validate with Ollama before approving as a master template.
        </p>
      </div>

      {error ? <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div> : null}

      {loading ? (
        <p className="text-sm text-slate-500">Loading...</p>
      ) : pending.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-500">
          Nothing waiting on review. Upload a specification from the Templates page to get started.
        </Card>
      ) : (
        <div className="space-y-4">
          {pending.map((t) => {
            const { fields, sections } = countFields(t)
            return (
              <Card key={t.id} className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-slate-900">{t.template_name}</h3>
                      <Badge type="draft">DRAFT</Badge>
                      {(t.page_images?.length || t.page_html?.length || t.page_count) ? (
                        <Badge type="info">
                          {t.page_images?.length || t.page_html?.length || t.page_count} Pages
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm text-slate-500 mt-1">
                      Parsed from {t.source_filename || 'uploaded file'} &middot; {fields} fields across {sections}{' '}
                      section{sections === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap justify-end">
                    <button
                      onClick={() => handlePageByPageReview(t.id)}
                      className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
                    >
                      Review Pages
                    </button>
                    <button
                      onClick={() => handleRemovePending(t.id)}
                      className="px-4 py-2 border border-red-200 text-red-700 bg-red-50 rounded hover:bg-red-100 transition"
                    >
                      Remove Pending
                    </button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}