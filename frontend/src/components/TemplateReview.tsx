import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import { Icons } from './icons'
import {
  approvePendingTemplate,
  getPendingTemplate,
  rejectPendingTemplate,
  updatePendingTemplate,
} from '../services/api'
import type { PendingTemplateResponse, TemplateField, TemplateSection, DocumentSection } from '../types'

function newField(): TemplateField {
  return {
    field_id: '',
    field_label: '',
    data_type: 'string',
    required: false,
    extraction_hint: '',
    validation_rules: [],
  }
}

export default function TemplateReview() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [template, setTemplate] = useState<PendingTemplateResponse | null>(null)
  const [sections, setSections] = useState<TemplateSection[]>([])
  const [templateName, setTemplateName] = useState('')
  const [description, setDescription] = useState('')
  const [specNumber, setSpecNumber] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'approve' | 'reject' | null>(null)
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await getPendingTemplate(Number(id))
        if (!cancelled) {
          setTemplate(result)
          setSections(result.sections ?? [])
          setTemplateName(result.template_name)
          setDescription(result.description ?? '')
          setSpecNumber(result.specification_number ?? '')
        }
      } catch (err) {
        if (!cancelled) setError(`Could not load this template: ${(err as Error).message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id])

  const firstPageOnlySections = sections
    .map((section) => ({
      ...section,
      fields: section.fields.filter((field) => field.page_number == null || field.page_number === 1),
    }))
    .filter((section) => section.fields.length > 0)

  const totalFields = firstPageOnlySections.reduce((sum, s) => sum + s.fields.length, 0)

  function updateField(sectionIdx: number, fieldIdx: number, patch: Partial<TemplateField>) {
    setSections((prev) =>
      prev.map((section, si) =>
        si !== sectionIdx
          ? section
          : { ...section, fields: section.fields.map((f, fi) => (fi === fieldIdx ? { ...f, ...patch } : f)) },
      ),
    )
  }

  function removeField(sectionIdx: number, fieldIdx: number) {
    setSections((prev) =>
      prev.map((section, si) =>
        si !== sectionIdx ? section : { ...section, fields: section.fields.filter((_, fi) => fi !== fieldIdx) },
      ),
    )
  }

  function addField(sectionIdx: number) {
    setSections((prev) =>
      prev.map((section, si) => (si !== sectionIdx ? section : { ...section, fields: [...section.fields, newField()] })),
    )
  }

  function removeSection(sectionIdx: number) {
    setSections((prev) => prev.filter((_, si) => si !== sectionIdx))
  }

  function addSection() {
    setSections((prev) => [
      ...prev,
      { section_id: `section_${prev.length + 1}`, section_name: 'New Section', fields: [newField()] },
    ])
  }

  function buildPayload() {
    return sections.map((section) => ({
      ...section,
      fields: section.fields
        .filter((f) => f.field_label.trim().length > 0)
        .map((f) => ({
          ...f,
          field_id: f.field_id.trim() || f.field_label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        })),
    }))
  }

  async function handleSave() {
    if (!template) return
    setBusy('save')
    setError(null)
    try {
      const payload = {
        template_name: templateName,
        description,
        specification_number: specNumber,
        sections: buildPayload(),
      }
      const updated = await updatePendingTemplate(template.id, payload)
      const refreshed = await getPendingTemplate(template.id)
      setTemplate(refreshed)
      setSections(refreshed.sections ?? [])
      setTemplateName(refreshed.template_name)
      setDescription(refreshed.description ?? '')
      setSpecNumber(refreshed.specification_number ?? '')
      if (updated && updated.sections) {
        setSections(updated.sections)
      }
    } catch (err) {
      setError(`Could not save changes: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function handleApprove() {
    if (!template) return
    setBusy('approve')
    setError(null)
    try {
      await updatePendingTemplate(template.id, {
        template_name: templateName,
        description,
        specification_number: specNumber,
        sections: buildPayload(),
      })
      const refreshed = await getPendingTemplate(template.id)
      setTemplate(refreshed)
      setSections(refreshed.sections ?? [])
      await approvePendingTemplate(template.id)
      navigate('/templates', { replace: true })
    } catch (err) {
      setError(`Could not approve this template: ${(err as Error).message}`)
      setBusy(null)
    }
  }

  async function handleReject() {
    if (!template) return
    if (!window.confirm('Discard this draft template? This cannot be undone.')) return
    setBusy('reject')
    setError(null)
    try {
      await rejectPendingTemplate(template.id)
      navigate('/templates/pending')
    } catch (err) {
      setError(`Could not discard this template: ${(err as Error).message}`)
      setBusy(null)
    }
  }

  if (loading) {
    return <div className="p-8 max-w-4xl mx-auto text-sm text-slate-500">Loading...</div>
  }

  if (!template) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <p className="text-sm text-red-800">{error || 'Template not found.'}</p>
        <Link to="/templates/pending" className="text-sm text-blue-600 hover:underline">
          &larr; Back to pending review
        </Link>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl mx-auto overflow-y-auto h-full pb-24">
      <Link to="/templates/pending" className="text-sm text-blue-600 hover:underline">
        &larr; Back to pending review
      </Link>

      <div className="mt-2 mb-6 flex items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900">Validate template</h1>
        <Badge type="draft">DRAFT</Badge>
      </div>

      {error ? <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div> : null}

      <Card className="p-6 mb-6">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Master template details</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-slate-600">Template name</span>
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-600">Specification number</span>
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={specNumber}
              onChange={(e) => setSpecNumber(e.target.value)}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-sm text-slate-600">Description</span>
            <textarea
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-slate-400 mt-3">
          Parsed from <span className="font-medium">{template.source_filename}</span> with <span className="font-medium">{template.page_count ?? 1}</span> pages. This is a starting point, not a final read - check every field below against the source document before approving.
        </p>
        {template.text_preview ? (
          <button
            type="button"
            className="text-xs text-blue-600 hover:underline mt-2"
            onClick={() => setShowSource((v) => !v)}
          >
            {showSource ? 'Hide source text' : 'Show extracted source text'}
          </button>
        ) : null}
        {showSource && template.text_preview ? (
          <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs bg-slate-50 border border-slate-200 rounded-md p-3 text-slate-600">
            {template.text_preview}
          </pre>
        ) : null}

      </Card>

      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide">Template fields ({totalFields})</h2>
          <p className="text-xs text-slate-500 mt-1">Keep only the sections and fields that belong in the final master template.</p>
        </div>
        <Button variant="secondary" onClick={addSection}>
          + Add section
        </Button>
      </div>

      <div className="space-y-6">
        {firstPageOnlySections.map((section, sectionIdx) => (
          <Card key={sectionIdx} className="p-5">
            <div className="flex items-center gap-3 mb-3">
              <input
                className="flex-1 font-semibold text-slate-900 text-sm border-b border-transparent hover:border-slate-300 focus:border-blue-400 focus:outline-none px-1 py-1"
                value={section.section_name}
                onChange={(e) =>
                  setSections((prev) =>
                    prev.map((s, si) => (si !== sectionIdx ? s : { ...s, section_name: e.target.value })),
                  )
                }
              />
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500 shrink-0">
                <input type="checkbox" checked readOnly />
                Keep section
              </label>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-slate-400 hover:text-red-600 text-xs font-medium"
                title="Remove section"
                onClick={() => removeSection(sectionIdx)}
              >
                <Icons.MinusCircle className="w-4 h-4" />
                Remove
              </button>
            </div>

            <div className="space-y-2">
              {section.fields.map((field, fieldIdx) => (
                <div key={fieldIdx} className="flex items-center gap-2">
                  <input
                    className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                    placeholder="Field label"
                    value={field.field_label}
                    onChange={(e) => updateField(sectionIdx, fieldIdx, { field_label: e.target.value })}
                  />
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 shrink-0">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => updateField(sectionIdx, fieldIdx, { required: e.target.checked })}
                    />
                    Required
                  </label>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 text-slate-400 hover:text-red-600 shrink-0 text-xs font-medium"
                    title="Remove field"
                    onClick={() => removeField(sectionIdx, fieldIdx)}
                  >
                    <Icons.MinusCircle className="w-4 h-4" />
                    Remove
                  </button>
                </div>
              ))}
              <Button variant="secondary" onClick={() => addField(sectionIdx)}>
                + Add field
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-8 flex gap-3 sticky bottom-0 bg-white py-4 border-t border-slate-200">
        <Button variant="outline" onClick={handleReject} disabled={busy === 'reject'}>
          Discard
        </Button>
        <Button variant="secondary" onClick={handleSave} disabled={busy === 'save'}>
          {busy === 'save' ? 'Saving...' : 'Save draft'}
        </Button>
        <Button onClick={handleApprove} disabled={busy === 'approve'} style={{ marginLeft: 'auto' }}>
          {busy === 'approve' ? 'Saving master template...' : 'Save as Master Template'}
        </Button>
      </div>
    </div>
  )
}
