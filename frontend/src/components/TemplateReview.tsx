import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import { Icons } from './icons'
import {
  approvePendingTemplate,
  getPendingTemplate,
  rejectPendingTemplate,
  updatePendingTemplate,
} from '../services/api'
import type { PendingTemplateResponse, TemplateField, TemplateSection, StaticBlock } from '../types'
import StaticContentForm from './StaticContentForm'

// ---------------------------------------------------------------------------
// Jira-style inline editable text
// ---------------------------------------------------------------------------
interface InlineEditProps {
  value: string
  onConfirm: (v: string) => void
  placeholder?: string
  className?: string
  inputClassName?: string
  multiline?: boolean
}

function InlineEdit({ value, onConfirm, placeholder = 'Click to edit', className = '', inputClassName = '', multiline = false }: InlineEditProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

  // Sync external value changes (e.g. after save/reload)
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  function startEdit() {
    setDraft(value)
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function confirm() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onConfirm(trimmed)
    else setDraft(value)
    setEditing(false)
  }

  function cancel() {
    setDraft(value)
    setEditing(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !multiline) { e.preventDefault(); confirm() }
    if (e.key === 'Escape') cancel()
  }

  if (editing) {
    return (
      <span className={`inline-flex items-center gap-1 ${className}`}>
        {multiline ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            className={`rounded border border-blue-400 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none ${inputClassName}`}
            value={draft}
            rows={2}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className={`rounded border border-blue-400 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 ${inputClassName}`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <button
          type="button"
          title="Confirm (Enter)"
          onClick={confirm}
          className="flex items-center justify-center w-6 h-6 rounded bg-blue-500 hover:bg-blue-600 text-white text-xs font-bold shrink-0 transition-colors"
        >
          ✓
        </button>
        <button
          type="button"
          title="Cancel (Esc)"
          onClick={cancel}
          className="flex items-center justify-center w-6 h-6 rounded border border-slate-300 hover:border-red-400 hover:text-red-500 text-slate-500 text-xs font-bold shrink-0 transition-colors"
        >
          ✕
        </button>
      </span>
    )
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={startEdit}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && startEdit()}
      title="Click to edit"
      className={`cursor-pointer group inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-blue-50 hover:ring-1 hover:ring-blue-200 transition-all ${className}`}
    >
      <span className={!value ? 'text-slate-400 italic' : ''}>{value || placeholder}</span>
      <span className="opacity-0 group-hover:opacity-100 text-blue-400 text-xs ml-0.5 transition-opacity">✎</span>
    </span>
  )
}

// ---------------------------------------------------------------------------

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
  const [staticBlocks, setStaticBlocks] = useState<StaticBlock[]>([])
  const [templateName, setTemplateName] = useState('')
  const [description, setDescription] = useState('')
  const [specNumber, setSpecNumber] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'approve' | 'reject' | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [activePage, setActivePage] = useState(1)
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())

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
          setStaticBlocks(result.static_blocks ?? [])
          setTemplateName(result.template_name)
          setDescription(result.description ?? '')
          setSpecNumber(result.specification_number ?? '')
          // Expand all sections by default
          setExpandedSections(new Set((result.sections ?? []).map((_, i) => i)))
        }
      } catch (err) {
        if (!cancelled) setError(`Could not load this template: ${(err as Error).message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [id])

  const pageCount = template?.page_count ?? 1
  const totalFields = sections.reduce((sum, s) => sum + s.fields.length, 0)

  function toggleSection(idx: number) {
    setExpandedSections(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  function updateSectionName(sectionIdx: number, name: string) {
    setSections(prev => prev.map((s, si) => si !== sectionIdx ? s : { ...s, section_name: name }))
  }

  function updateField(sectionIdx: number, fieldIdx: number, patch: Partial<TemplateField>) {
    setSections(prev =>
      prev.map((section, si) =>
        si !== sectionIdx
          ? section
          : { ...section, fields: section.fields.map((f, fi) => (fi === fieldIdx ? { ...f, ...patch } : f)) },
      ),
    )
  }

  function removeField(sectionIdx: number, fieldIdx: number) {
    setSections(prev =>
      prev.map((section, si) =>
        si !== sectionIdx ? section : { ...section, fields: section.fields.filter((_, fi) => fi !== fieldIdx) },
      ),
    )
  }

  function addField(sectionIdx: number) {
    setSections(prev =>
      prev.map((section, si) => (si !== sectionIdx ? section : { ...section, fields: [...section.fields, newField()] })),
    )
  }

  function removeSection(sectionIdx: number) {
    setSections(prev => prev.filter((_, si) => si !== sectionIdx))
    setExpandedSections(prev => {
      const next = new Set<number>()
      prev.forEach(i => { if (i < sectionIdx) next.add(i); else if (i > sectionIdx) next.add(i - 1) })
      return next
    })
  }

  function addSection() {
    setSections(prev => [
      ...prev,
      { section_id: `section_${prev.length + 1}`, section_name: 'New Section', fields: [newField()] },
    ])
    setExpandedSections(prev => new Set([...prev, sections.length]))
  }

  function handleStaticTextChange(blockId: string, text: string) {
    setStaticBlocks(prev => prev.map(b => (b.block_id === blockId ? { ...b, text } : b)))
  }

  function handlePromoteStaticBlock(block: StaticBlock) {
    setSections(prev => {
      const targetIdx = prev.findIndex(s => s.section_id === 'promoted_fields')
      const field: TemplateField = {
        field_id: '',
        field_label: block.text.trim() || `Field (page ${block.page_number})`,
        data_type: 'string',
        required: false,
        page_number: block.page_number,
        extraction_hint: block.text.trim()
          ? `This was static text in the source document ("${block.text.trim().slice(0, 80)}") - promoted to a dynamic field during template review.`
          : `Blank in the source document (page ${block.page_number}) - promoted to a dynamic field during template review; fill it in per-project.`,
        validation_rules: [],
      }
      if (targetIdx === -1) {
        return [...prev, { section_id: 'promoted_fields', section_name: 'Promoted From Static Content', fields: [field] }]
      }
      return prev.map((s, i) => (i !== targetIdx ? s : { ...s, fields: [...s.fields, field] }))
    })
    setStaticBlocks(prev => prev.filter(b => b.block_id !== block.block_id))
  }

  function buildPayload() {
    return sections.map(section => ({
      ...section,
      fields: section.fields
        .filter(f => f.field_label.trim().length > 0)
        .map(f => ({
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
        static_blocks: staticBlocks,
      }
      await updatePendingTemplate(template.id, payload)
      const refreshed = await getPendingTemplate(template.id)
      setTemplate(refreshed)
      setSections(refreshed.sections ?? [])
      setStaticBlocks(refreshed.static_blocks ?? [])
      setTemplateName(refreshed.template_name)
      setDescription(refreshed.description ?? '')
      setSpecNumber(refreshed.specification_number ?? '')
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
        static_blocks: staticBlocks,
      })
      const refreshed = await getPendingTemplate(template.id)
      setTemplate(refreshed)
      setSections(refreshed.sections ?? [])
      setStaticBlocks(refreshed.static_blocks ?? [])
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
        <Link to="/templates/pending" className="text-sm text-brand hover:underline">
          ← Back to pending review
        </Link>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-6xl mx-auto overflow-y-auto h-full pb-24">
      <Link to="/templates/pending" className="text-sm text-brand hover:underline">
        ← Back to pending review
      </Link>

      <div className="mt-2 mb-6 flex items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900">Validate template</h1>
        <Badge type="draft">DRAFT</Badge>
      </div>

      {error ? <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div> : null}

      {/* ── Template metadata card ── */}
      <Card className="p-6 mb-6">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Master template details</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-6">
          <div>
            <p className="text-xs text-slate-500 mb-1">Template name</p>
            <InlineEdit
              value={templateName}
              onConfirm={setTemplateName}
              placeholder="Template name"
              inputClassName="w-64"
              className="font-medium text-slate-900"
            />
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-1">Specification number</p>
            <InlineEdit
              value={specNumber}
              onConfirm={setSpecNumber}
              placeholder="e.g. IP009-43-00-01"
              inputClassName="w-48"
              className="text-slate-800"
            />
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs text-slate-500 mb-1">Description</p>
            <InlineEdit
              value={description}
              onConfirm={setDescription}
              placeholder="Add a description..."
              inputClassName="w-full"
              className="text-slate-700 text-sm"
              multiline
            />
          </div>
        </div>
        <p className="text-xs text-slate-400 mt-4">
          Parsed from <span className="font-medium">{template.source_filename}</span> with{' '}
          <span className="font-medium">{template.page_count ?? 1}</span> pages.
        </p>
        {template.text_preview ? (
          <button
            type="button"
            className="text-xs text-brand hover:underline mt-2"
            onClick={() => setShowSource(v => !v)}
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

      {/* ── Section / Fields grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* LEFT: Dynamic fields — ALL sections from schema */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between mb-1">
            <div>
              <div className="flex items-center gap-2">
                <Badge type="review">DYNAMIC FIELDS</Badge>
                <span className="text-[11px] text-slate-400">
                  {sections.length} section{sections.length !== 1 ? 's' : ''} · {totalFields} field{totalFields !== 1 ? 's' : ''}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Click any name or label to edit inline. Use ✓ to confirm or ✕ to cancel.
              </p>
            </div>
            <Button variant="secondary" onClick={addSection}>+ Add section</Button>
          </div>

          {sections.length === 0 ? (
            <Card className="p-6 text-center text-sm text-slate-500">
              No sections defined yet. Click "+ Add section" to start.
            </Card>
          ) : (
            sections.map((section, sectionIdx) => {
              const isExpanded = expandedSections.has(sectionIdx)
              return (
                <Card key={sectionIdx} className="overflow-hidden">
                  {/* Section header */}
                  <div
                    className="flex items-center gap-2 px-5 py-3 bg-slate-50 border-b border-slate-100 cursor-pointer select-none"
                    onClick={() => toggleSection(sectionIdx)}
                  >
                    <span className="text-slate-400 text-xs w-4 shrink-0">
                      {isExpanded ? '▾' : '▸'}
                    </span>

                    {/* Inline-editable section name — stop click propagation so
                        clicking the edit pencil doesn't toggle collapse */}
                    <span onClick={e => e.stopPropagation()} className="flex-1 min-w-0">
                      <InlineEdit
                        value={section.section_name}
                        onConfirm={name => updateSectionName(sectionIdx, name)}
                        placeholder="Section name"
                        inputClassName="w-56"
                        className="font-semibold text-slate-900 text-sm"
                      />
                    </span>

                    <span className="text-[11px] text-slate-400 shrink-0 ml-1">
                      {section.fields.length} field{section.fields.length !== 1 ? 's' : ''}
                    </span>

                    <button
                      type="button"
                      title="Remove section"
                      onClick={e => { e.stopPropagation(); removeSection(sectionIdx) }}
                      className="inline-flex items-center gap-1 text-slate-400 hover:text-red-600 text-xs font-medium shrink-0 ml-2"
                    >
                      <Icons.MinusCircle className="w-4 h-4" /> Remove
                    </button>
                  </div>

                  {/* Section fields */}
                  {isExpanded && (
                    <div className="px-5 py-4 space-y-2">
                      {section.fields.length === 0 ? (
                        <p className="text-xs text-slate-400 italic">No fields — add one below.</p>
                      ) : (
                        section.fields.map((field, fieldIdx) => (
                          <div
                            key={fieldIdx}
                            className="flex items-center gap-3 py-1.5 border-b border-slate-100 last:border-0 group/field"
                          >
                            {/* Inline-editable field label */}
                            <div className="flex-1 min-w-0">
                              <InlineEdit
                                value={field.field_label}
                                onConfirm={label => updateField(sectionIdx, fieldIdx, { field_label: label })}
                                placeholder="Field label"
                                inputClassName="w-52"
                                className="text-sm text-slate-800"
                              />
                            </div>

                            {/* Data type selector */}
                            <select
                              className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 focus:outline-none focus:ring-1 focus:ring-brand shrink-0"
                              value={field.data_type}
                              onChange={e => updateField(sectionIdx, fieldIdx, { data_type: e.target.value })}
                              title="Data type"
                            >
                              <option value="string">Text</option>
                              <option value="number">Number</option>
                              <option value="date">Date</option>
                              <option value="boolean">Yes/No</option>
                              <option value="table">Table</option>
                            </select>

                            <label className="flex items-center gap-1.5 text-xs text-slate-500 shrink-0">
                              <input
                                type="checkbox"
                                checked={field.required}
                                onChange={e => updateField(sectionIdx, fieldIdx, { required: e.target.checked })}
                              />
                              Required
                            </label>

                            <button
                              type="button"
                              title="Remove field"
                              onClick={() => removeField(sectionIdx, fieldIdx)}
                              className="inline-flex items-center gap-1 text-slate-300 hover:text-red-600 text-xs font-medium shrink-0 opacity-0 group-hover/field:opacity-100 transition-opacity"
                            >
                              <Icons.MinusCircle className="w-4 h-4" />
                            </button>
                          </div>
                        ))
                      )}
                      <Button variant="secondary" onClick={() => addField(sectionIdx)} className="mt-2 text-xs py-1">
                        + Add field
                      </Button>
                    </div>
                  )}
                </Card>
              )
            })
          )}
        </div>

        {/* RIGHT: Static content / page preview */}
        <div className="space-y-3 lg:sticky lg:top-4">
          {pageCount > 1 ? (
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
              <button
                type="button"
                className="disabled:opacity-30"
                disabled={activePage <= 1}
                onClick={() => setActivePage(p => Math.max(1, p - 1))}
              >
                <Icons.ChevronLeft className="w-4 h-4" />
              </button>
              <span>Page {activePage} of {pageCount}</span>
              <button
                type="button"
                className="disabled:opacity-30"
                disabled={activePage >= pageCount}
                onClick={() => setActivePage(p => Math.min(pageCount, p + 1))}
              >
                <Icons.ChevronRight className="w-4 h-4" />
              </button>
            </div>
          ) : null}
          <StaticContentForm
            blocks={staticBlocks}
            activePage={activePage}
            onChangeText={handleStaticTextChange}
            onPromote={handlePromoteStaticBlock}
          />
        </div>
      </div>

      {/* ── Sticky footer ── */}
      <div className="mt-8 flex gap-3 sticky bottom-0 bg-white py-4 border-t border-slate-200">
        <Button variant="ghost" onClick={handleReject} disabled={busy === 'reject'}>
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