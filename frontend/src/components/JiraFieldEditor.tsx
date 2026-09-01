/**
 * JiraFieldEditor — single-page Jira-style field review editor.
 *
 * Route: /projects/:projectId/edit/:jobId
 *
 * Layout
 * ------
 *  Header    — template name + structural-validation badge
 *  Toolbar   — filter pills (All / Unmatched / Low confidence) + sort
 *  Sections  — collapsible accordions, one per schema section
 *  Field row — [●dot] [label] [source badge "p.N"] [value input]
 *  Footer    — sticky Download DOCX / PDF bar with pre-download re-check
 *
 * Design tokens live in-file (no external CSS file dependency).
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  structuralCheck,
  validateOutput,
  type StructuralValidationResult,
  type StructuralValidationStatus,
} from '../services/api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceReference {
  page_number: number | null
  source_text: string | null
  confidence: number | null
  bounding_box: unknown | null
}

interface ExtractedField {
  field_id: string
  field_label: string
  value: string | null
  original_value: string | null
  confidence: number | null
  validation_status: string
  verification_status: string | null
  is_dynamic: boolean
  source_references: SourceReference[]
}

interface ExtractionJob {
  id: number
  project_id: number
  document_id: number
  template_id: number
  status: string
  progress: number
  error_message: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  extracted_fields: ExtractedField[]
}

interface SchemaField {
  field_id: string
  field_label: string
  clause_ref: string
  data_type: string
  required: boolean
  is_dynamic?: boolean
  label_patterns?: string[]
  default_value?: string
}

interface SchemaSection {
  section_id: string
  section_number: string
  section_name: string
  field_type?: 'table'
  rows_editable?: boolean
  columns?: string[]
  rows?: Array<{ row_id: string; values: string[] }>
  fields: SchemaField[]
}

interface SchemaTemplate {
  template_id: string
  template_name: string
  version: string
  sections: SchemaSection[]
}

// ---------------------------------------------------------------------------
// API helpers (local, avoid adding more to api.ts)
// ---------------------------------------------------------------------------

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || '/api'

async function fetchJob(jobId: string): Promise<ExtractionJob> {
  const r = await fetch(`${API_BASE}/extraction/${jobId}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function fetchTemplate(templateId: number): Promise<SchemaTemplate> {
  const r = await fetch(`${API_BASE}/templates/by-db-id/${templateId}`, { cache: 'no-store' })
  if (!r.ok) {
    // fallback: templates list
    const list = await fetch(`${API_BASE}/templates`, { cache: 'no-store' }).then(x => x.json())
    return list.find((t: SchemaTemplate & { id: number }) => t.id === templateId) ?? null
  }
  return r.json()
}

async function patchField(
  jobId: string,
  fieldId: string,
  value: string,
  validationStatus = 'verified',
): Promise<void> {
  await fetch(`${API_BASE}/extraction/${jobId}/fields/${fieldId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, validation_status: validationStatus }),
  })
}

async function downloadExport(jobId: string, format: 'docx' | 'pdf'): Promise<void> {
  const r = await fetch(`${API_BASE}/extraction/${jobId}/export?format=${format}`, {
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(await r.text())
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `extraction_${jobId}.${format}`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Confidence helpers
// ---------------------------------------------------------------------------

type DotColor = 'green' | 'yellow' | 'red'

function dotColor(confidence: number | null): DotColor {
  if (confidence == null || confidence < 0.7) return 'red'
  if (confidence >= 0.95) return 'green'
  return 'yellow'
}

const DOT_STYLES: Record<DotColor, React.CSSProperties> = {
  green: { background: '#22c55e' },
  yellow: { background: '#eab308' },
  red: { background: '#ef4444' },
}

// ---------------------------------------------------------------------------
// Debounce hook
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debouncedValue
}

// ---------------------------------------------------------------------------
// Source badge + popover
// ---------------------------------------------------------------------------

function SourceBadge({ refs }: { refs: SourceReference[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const primary = refs[0]
  if (!primary) return null

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="View source"
        style={{
          background: 'rgba(99,102,241,0.15)',
          border: '1px solid rgba(99,102,241,0.35)',
          borderRadius: '6px',
          color: '#a5b4fc',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: 600,
          padding: '2px 7px',
          lineHeight: '18px',
          whiteSpace: 'nowrap',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => ((e.target as HTMLElement).style.background = 'rgba(99,102,241,0.28)')}
        onMouseLeave={e => ((e.target as HTMLElement).style.background = 'rgba(99,102,241,0.15)')}
      >
        {primary.page_number != null ? `p.${primary.page_number}` : 'src'}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '110%',
            left: 0,
            zIndex: 100,
            background: '#1e1e2e',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '10px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            padding: '12px 14px',
            minWidth: '280px',
            maxWidth: '400px',
          }}
        >
          {refs.map((r, i) => (
            <div key={i} style={{ marginBottom: i < refs.length - 1 ? '10px' : 0 }}>
              <div style={{ color: '#a5b4fc', fontSize: '11px', fontWeight: 700, marginBottom: '4px' }}>
                {r.page_number != null ? `Page ${r.page_number}` : 'Unknown page'}
                {r.confidence != null && (
                  <span style={{ color: '#94a3b8', marginLeft: '8px', fontWeight: 400 }}>
                    {Math.round(r.confidence * 100)}% confidence
                  </span>
                )}
              </div>
              {r.source_text && (
                <div
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    borderRadius: '6px',
                    color: '#e2e8f0',
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    padding: '6px 9px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {r.source_text}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Field row
// ---------------------------------------------------------------------------

function FieldRow({
  field,
  jobId,
  onValueChange,
}: {
  field: ExtractedField
  jobId: string
  onValueChange: (fieldId: string, value: string) => void
}) {
  const [localValue, setLocalValue] = useState(field.value ?? '')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const prevSaved = useRef(localValue)
  const debouncedValue = useDebounce(localValue, 400)

  // Auto-save on debounced change (only when editing and value has changed)
  useEffect(() => {
    if (!editing) return
    if (debouncedValue === prevSaved.current) return
    setSaving(true)
    patchField(jobId, field.field_id, debouncedValue)
      .then(() => {
        prevSaved.current = debouncedValue
        onValueChange(field.field_id, debouncedValue)
      })
      .finally(() => setSaving(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedValue])

  const color = dotColor(field.confidence)
  const isEmpty = !field.value && !localValue
  const isStatic = !field.is_dynamic

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '14px 1fr auto auto',
        gap: '10px',
        alignItems: 'center',
        padding: '9px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: isStatic ? 'rgba(255,255,255,0.01)' : 'transparent',
        transition: 'background 0.15s',
        opacity: isStatic ? 0.65 : 1,
      }}
    >
      {/* Confidence dot */}
      <div
        title={`Confidence: ${field.confidence != null ? Math.round(field.confidence * 100) + '%' : 'N/A'}`}
        style={{
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          flexShrink: 0,
          ...DOT_STYLES[color],
          boxShadow: `0 0 6px 1px ${DOT_STYLES[color].background}60`,
        }}
      />

      {/* Label */}
      <div style={{ overflow: 'hidden' }}>
        <span
          style={{
            color: '#cbd5e1',
            fontSize: '13px',
            fontStyle: isStatic ? 'italic' : 'normal',
          }}
        >
          {field.field_label}
        </span>
        {field.validation_status === 'missing' && (
          <span
            style={{
              background: 'rgba(239,68,68,0.15)',
              borderRadius: '4px',
              color: '#f87171',
              fontSize: '10px',
              fontWeight: 700,
              marginLeft: '8px',
              padding: '1px 5px',
            }}
          >
            REQUIRED
          </span>
        )}
      </div>

      {/* Source badge */}
      <div style={{ minWidth: '36px', textAlign: 'center' }}>
        {field.source_references.length > 0 ? (
          <SourceBadge refs={field.source_references} />
        ) : (
          <span style={{ color: '#475569', fontSize: '11px' }}>—</span>
        )}
      </div>

      {/* Value input */}
      <div style={{ minWidth: '220px', maxWidth: '340px' }}>
        {isStatic && !editing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: '#94a3b8', fontSize: '13px' }}>
              {field.value || <em style={{ color: '#475569' }}>—</em>}
            </span>
            <button
              onClick={() => setEditing(true)}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '4px',
                color: '#64748b',
                cursor: 'pointer',
                fontSize: '10px',
                padding: '1px 6px',
              }}
            >
              Override
            </button>
          </div>
        ) : (
          <input
            id={`field-${field.field_id}`}
            value={localValue}
            onChange={e => setLocalValue(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            placeholder={isEmpty ? 'Click to enter…' : ''}
            style={{
              background: editing
                ? 'rgba(99,102,241,0.08)'
                : isEmpty
                ? 'rgba(239,68,68,0.06)'
                : 'rgba(255,255,255,0.04)',
              border: `1px solid ${
                editing ? 'rgba(99,102,241,0.5)' : isEmpty ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.08)'
              }`,
              borderRadius: '7px',
              color: isEmpty ? '#64748b' : '#e2e8f0',
              fontSize: '13px',
              outline: 'none',
              padding: '5px 10px',
              transition: 'all 0.15s',
              width: '100%',
              boxSizing: 'border-box',
            }}
          />
        )}
        {saving && (
          <div style={{ color: '#64748b', fontSize: '10px', marginTop: '2px', textAlign: 'right' }}>
            saving…
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section accordion
// ---------------------------------------------------------------------------

function SectionAccordion({
  section,
  fields,
  jobId,
  onValueChange,
}: {
  section: SchemaSection
  fields: ExtractedField[]
  jobId: string
  onValueChange: (fieldId: string, value: string) => void
}) {
  const [open, setOpen] = useState(true)
  const unmatchedCount = fields.filter(f => !f.value && f.is_dynamic).length

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '12px',
        marginBottom: '10px',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          gap: '10px',
          justifyContent: 'space-between',
          padding: '13px 16px',
          width: '100%',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>
            {section.section_number}
          </span>
          <span style={{ color: '#e2e8f0', fontSize: '14px', fontWeight: 600 }}>
            {section.section_name}
          </span>
          {unmatchedCount > 0 && (
            <span
              style={{
                background: 'rgba(239,68,68,0.15)',
                borderRadius: '10px',
                color: '#f87171',
                fontSize: '11px',
                fontWeight: 700,
                padding: '1px 8px',
              }}
            >
              {unmatchedCount} unmatched
            </span>
          )}
        </div>
        <span style={{ color: '#64748b', fontSize: '16px', lineHeight: 1 }}>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {fields.length === 0 ? (
            <div style={{ color: '#475569', fontSize: '13px', padding: '12px 16px' }}>
              No fields in this section.
            </div>
          ) : (
            fields.map(f => (
              <FieldRow
                key={f.field_id}
                field={f}
                jobId={jobId}
                onValueChange={onValueChange}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Validation banner
// ---------------------------------------------------------------------------

function ValidationBanner({ result }: { result: StructuralValidationResult }) {
  const [expanded, setExpanded] = useState(false)
  if (result.status === 'MATCH') return null

  const isMismatch = result.status === 'MISMATCH'
  const bg = isMismatch ? 'rgba(239,68,68,0.1)' : 'rgba(234,179,8,0.1)'
  const border = isMismatch ? 'rgba(239,68,68,0.35)' : 'rgba(234,179,8,0.35)'
  const color = isMismatch ? '#f87171' : '#facc15'
  const icon = isMismatch ? '⚠️' : '🔍'
  const label = isMismatch ? 'Structural mismatch detected' : 'Review recommended'
  const sub = isMismatch
    ? 'This document may not match the master template. Results may be unreliable.'
    : 'Some sections were only partially matched. Review highlighted fields before downloading.'

  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: '10px',
        marginBottom: '16px',
        padding: '12px 16px',
      }}
    >
      <div style={{ alignItems: 'flex-start', display: 'flex', gap: '10px' }}>
        <span style={{ fontSize: '18px', lineHeight: 1 }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ color, fontWeight: 700, fontSize: '14px' }}>{label}</div>
          <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '2px' }}>{sub}</div>
          {result.details.length > 0 && (
            <button
              onClick={() => setExpanded(e => !e)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#64748b',
                cursor: 'pointer',
                fontSize: '11px',
                marginTop: '6px',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              {expanded ? 'Hide details' : `Show ${result.details.length} detail(s)`}
            </button>
          )}
          {expanded && (
            <ul
              style={{
                color: '#94a3b8',
                fontSize: '12px',
                margin: '8px 0 0',
                paddingLeft: '18px',
              }}
            >
              {result.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Download bar
// ---------------------------------------------------------------------------

function DownloadBar({ jobId }: { jobId: string }) {
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<StructuralValidationResult | null>(null)
  const [downloading, setDownloading] = useState<'docx' | 'pdf' | null>(null)
  const [dismissed, setDismissed] = useState(false)

  async function handleDownload(format: 'docx' | 'pdf') {
    setChecking(true)
    setCheckResult(null)
    setDismissed(false)
    try {
      const result = await validateOutput(Number(jobId))
      if (result.status === 'MISMATCH' && !dismissed) {
        setCheckResult(result)
        setChecking(false)
        return
      }
    } catch {
      // If check fails, allow download
    }
    setChecking(false)
    setDownloading(format)
    try {
      await downloadExport(jobId, format)
    } finally {
      setDownloading(null)
    }
  }

  async function forceDownload(format: 'docx' | 'pdf') {
    setCheckResult(null)
    setDismissed(true)
    setDownloading(format)
    try {
      await downloadExport(jobId, format)
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div
      style={{
        background: 'rgba(15,15,25,0.97)',
        backdropFilter: 'blur(12px)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        bottom: 0,
        left: 0,
        padding: '12px 24px',
        position: 'sticky',
        right: 0,
        zIndex: 50,
      }}
    >
      {checkResult && checkResult.status === 'MISMATCH' && (
        <div
          style={{
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.35)',
            borderRadius: '8px',
            marginBottom: '10px',
            padding: '10px 14px',
          }}
        >
          <div style={{ color: '#f87171', fontWeight: 700, fontSize: '13px', marginBottom: '4px' }}>
            ⚠️ Output validation failed — MISMATCH detected
          </div>
          <ul style={{ color: '#94a3b8', fontSize: '11px', margin: '0 0 8px', paddingLeft: '16px' }}>
            {checkResult.details.slice(0, 3).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
            {checkResult.details.length > 3 && (
              <li>…and {checkResult.details.length - 3} more</li>
            )}
          </ul>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => forceDownload('docx')}
              style={{
                background: 'rgba(239,68,68,0.2)',
                border: '1px solid rgba(239,68,68,0.4)',
                borderRadius: '6px',
                color: '#fca5a5',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                padding: '5px 12px',
              }}
            >
              Download DOCX anyway
            </button>
            <button
              onClick={() => forceDownload('pdf')}
              style={{
                background: 'rgba(239,68,68,0.2)',
                border: '1px solid rgba(239,68,68,0.4)',
                borderRadius: '6px',
                color: '#fca5a5',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                padding: '5px 12px',
              }}
            >
              Download PDF anyway
            </button>
            <button
              onClick={() => setCheckResult(null)}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '6px',
                color: '#64748b',
                cursor: 'pointer',
                fontSize: '12px',
                padding: '5px 12px',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ alignItems: 'center', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
        {checking && (
          <span style={{ color: '#64748b', fontSize: '12px' }}>Validating output…</span>
        )}
        {['docx', 'pdf'].map(fmt => (
          <button
            key={fmt}
            disabled={!!downloading || checking}
            onClick={() => handleDownload(fmt as 'docx' | 'pdf')}
            style={{
              background:
                fmt === 'docx'
                  ? 'linear-gradient(135deg,#6366f1,#818cf8)'
                  : 'linear-gradient(135deg,#0f766e,#14b8a6)',
              border: 'none',
              borderRadius: '9px',
              color: '#fff',
              cursor: downloading || checking ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 700,
              opacity: downloading && downloading !== fmt ? 0.5 : 1,
              padding: '9px 20px',
              transition: 'opacity 0.15s, transform 0.1s',
            }}
            onMouseEnter={e => {
              if (!downloading && !checking)
                (e.target as HTMLElement).style.transform = 'translateY(-1px)'
            }}
            onMouseLeave={e => ((e.target as HTMLElement).style.transform = '')}
          >
            {downloading === fmt ? 'Downloading…' : `Download ${fmt.toUpperCase()}`}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: StructuralValidationStatus | null }) {
  if (!status) return null
  const map: Record<
    StructuralValidationStatus,
    { label: string; bg: string; color: string }
  > = {
    MATCH: { label: 'MATCH ✓', bg: 'rgba(34,197,94,0.15)', color: '#4ade80' },
    REVIEW: { label: 'REVIEW ⚠', bg: 'rgba(234,179,8,0.15)', color: '#facc15' },
    MISMATCH: { label: 'MISMATCH ✗', bg: 'rgba(239,68,68,0.15)', color: '#f87171' },
  }
  const { label, bg, color } = map[status]
  return (
    <span
      style={{
        background: bg,
        borderRadius: '8px',
        color,
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.05em',
        padding: '3px 10px',
      }}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type FilterMode = 'all' | 'unmatched' | 'low'
type SortMode = 'schema' | 'confidence'

export default function JiraFieldEditor() {
  const { projectId, jobId } = useParams<{ projectId: string; jobId: string }>()
  const navigate = useNavigate()

  const [job, setJob] = useState<ExtractionJob | null>(null)
  const [template, setTemplate] = useState<SchemaTemplate | null>(null)
  const [validation, setValidation] = useState<StructuralValidationResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterMode>('all')
  const [sort, setSort] = useState<SortMode>('schema')

  // Local field values (optimistic updates without re-fetching the whole job)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!jobId) return
    setLoading(true)
    Promise.all([fetchJob(jobId)])
      .then(async ([fetchedJob]) => {
        setJob(fetchedJob)
        // Fetch template schema
        try {
          const tmpl = await fetchTemplate(fetchedJob.template_id)
          setTemplate(tmpl)
        } catch {
          // No schema available — editor still works field-list-only
        }
        // Structural check (non-blocking — runs in background)
        structuralCheck(Number(jobId))
          .then(setValidation)
          .catch(() => {})
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [jobId])

  const handleValueChange = useCallback((fid: string, val: string) => {
    setFieldValues(prev => ({ ...prev, [fid]: val }))
  }, [])

  // Build merged field map (job fields + optimistic updates)
  const fieldById = useMemo(() => {
    if (!job) return {}
    const map: Record<string, ExtractedField> = {}
    for (const f of job.extracted_fields) {
      map[f.field_id] = fieldValues[f.field_id] != null
        ? { ...f, value: fieldValues[f.field_id] }
        : f
    }
    return map
  }, [job, fieldValues])

  // Build section→fields list ordered by schema
  const sectionFields = useMemo((): Array<{ section: SchemaSection; fields: ExtractedField[] }> => {
    if (!template || !job) return []
    return template.sections
      .filter(s => s.field_type !== 'table')  // Table sections handled separately
      .map(section => {
        let fields = section.fields
          .map(sf => fieldById[sf.field_id])
          .filter(Boolean) as ExtractedField[]

        // Apply filter
        if (filter === 'unmatched') fields = fields.filter(f => !f.value && f.is_dynamic)
        if (filter === 'low') fields = fields.filter(f => f.is_dynamic && (f.confidence ?? 0) < 0.85)

        // Apply sort
        if (sort === 'confidence') {
          fields = [...fields].sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0))
        }

        return { section, fields }
      })
      .filter(({ fields }) => filter === 'all' || fields.length > 0)
  }, [template, job, fieldById, filter, sort])

  // Stats
  const totalDynamic = useMemo(
    () => job?.extracted_fields.filter(f => f.is_dynamic).length ?? 0,
    [job],
  )
  const totalMatched = useMemo(
    () =>
      job?.extracted_fields.filter(f => f.is_dynamic && (f.value || fieldValues[f.field_id])).length ?? 0,
    [job, fieldValues],
  )
  const totalUnmatched = totalDynamic - totalMatched

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div style={fullPageCenter}>
        <div style={spinnerStyle} />
        <div style={{ color: '#64748b', fontSize: '14px', marginTop: '16px' }}>
          Loading editor…
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div style={fullPageCenter}>
        <div style={{ color: '#f87171', fontSize: '15px' }}>{error || 'Job not found'}</div>
        <button onClick={() => navigate(-1)} style={backBtnStyle}>
          ← Go back
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        background: '#0a0a14',
        color: '#e2e8f0',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
        minHeight: '100vh',
      }}
    >
      {/* ── Header ── */}
      <header
        style={{
          alignItems: 'center',
          background: 'rgba(15,15,25,0.95)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          gap: '16px',
          justifyContent: 'space-between',
          padding: '14px 24px',
          position: 'sticky',
          top: 0,
          zIndex: 40,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <button
            onClick={() => navigate(`/projects/${projectId}`)}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: '13px',
              padding: '6px 12px',
            }}
          >
            ← Back to Project
          </button>
          <div>
            <div style={{ color: '#e2e8f0', fontSize: '15px', fontWeight: 700 }}>
              {template?.template_name ?? `Job #${jobId}`}
            </div>
            <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>
              {template?.version && `v${template.version} · `}
              {totalMatched}/{totalDynamic} fields matched
              {totalUnmatched > 0 && (
                <span style={{ color: '#ef4444', marginLeft: '4px' }}>
                  · {totalUnmatched} need entry
                </span>
              )}
            </div>
          </div>
        </div>
        <StatusBadge status={validation?.status ?? null} />
      </header>

      {/* ── Main ── */}
      <main style={{ flex: 1, maxWidth: '960px', margin: '0 auto', padding: '20px 24px', width: '100%' }}>
        {/* Mismatch / Review banner */}
        {validation && validation.status !== 'MATCH' && (
          <ValidationBanner result={validation} />
        )}

        {/* Filter + sort toolbar */}
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            gap: '8px',
            marginBottom: '16px',
            flexWrap: 'wrap',
          }}
        >
          {(['all', 'unmatched', 'low'] as FilterMode[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: filter === f ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${filter === f ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '20px',
                color: filter === f ? '#a5b4fc' : '#64748b',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: filter === f ? 700 : 400,
                padding: '4px 14px',
                transition: 'all 0.15s',
              }}
            >
              {f === 'all' ? 'All fields' : f === 'unmatched' ? '🔴 Unmatched' : '🟡 Low confidence'}
              {f === 'unmatched' && totalUnmatched > 0 && (
                <span
                  style={{
                    background: 'rgba(239,68,68,0.25)',
                    borderRadius: '10px',
                    color: '#f87171',
                    fontSize: '10px',
                    fontWeight: 700,
                    marginLeft: '6px',
                    padding: '0 5px',
                  }}
                >
                  {totalUnmatched}
                </span>
              )}
            </button>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: '#64748b', fontSize: '12px' }}>Sort:</span>
            {(['schema', 'confidence'] as SortMode[]).map(s => (
              <button
                key={s}
                onClick={() => setSort(s)}
                style={{
                  background: sort === s ? 'rgba(255,255,255,0.08)' : 'transparent',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '6px',
                  color: sort === s ? '#e2e8f0' : '#64748b',
                  cursor: 'pointer',
                  fontSize: '12px',
                  padding: '3px 10px',
                }}
              >
                {s === 'schema' ? 'Default' : 'Confidence ↑'}
              </button>
            ))}
          </div>
        </div>

        {/* Field columns header */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '14px 1fr auto auto',
            gap: '10px',
            padding: '6px 16px',
            marginBottom: '4px',
          }}
        >
          <div />
          <div style={{ color: '#475569', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Field
          </div>
          <div style={{ color: '#475569', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Source
          </div>
          <div style={{ color: '#475569', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', minWidth: '220px' }}>
            Value
          </div>
        </div>

        {/* Sections */}
        {sectionFields.length > 0 ? (
          sectionFields.map(({ section, fields }) => (
            <SectionAccordion
              key={section.section_id}
              section={section}
              fields={fields}
              jobId={jobId!}
              onValueChange={handleValueChange}
            />
          ))
        ) : (
          // Fallback: no schema available, flat list
          <div
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: '12px',
              overflow: 'hidden',
            }}
          >
            {job.extracted_fields
              .filter(f => {
                if (filter === 'unmatched') return !f.value && f.is_dynamic
                if (filter === 'low') return f.is_dynamic && (f.confidence ?? 0) < 0.85
                return true
              })
              .sort((a, b) =>
                sort === 'confidence' ? (a.confidence ?? 0) - (b.confidence ?? 0) : 0,
              )
              .map(f => (
                <FieldRow
                  key={f.field_id}
                  field={f}
                  jobId={jobId!}
                  onValueChange={handleValueChange}
                />
              ))}
          </div>
        )}

        {/* Bottom padding so sticky footer doesn't cover last row */}
        <div style={{ height: '80px' }} />
      </main>

      {/* ── Sticky download bar ── */}
      <DownloadBar jobId={jobId!} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared micro-styles
// ---------------------------------------------------------------------------

const fullPageCenter: React.CSSProperties = {
  alignItems: 'center',
  background: '#0a0a14',
  color: '#e2e8f0',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: "'Inter', 'Segoe UI', sans-serif",
  height: '100vh',
  justifyContent: 'center',
  gap: '16px',
}

const spinnerStyle: React.CSSProperties = {
  border: '3px solid rgba(99,102,241,0.15)',
  borderTop: '3px solid #6366f1',
  borderRadius: '50%',
  width: '36px',
  height: '36px',
  animation: 'spin 0.8s linear infinite',
}

const backBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: '13px',
  padding: '7px 14px',
}
