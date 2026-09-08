/**
 * JiraFieldEditor — Full Document Structure Editor
 *
 * Route: /projects/:projectId/edit/:jobId
 *
 * Renders the COMPLETE document structure:
 * - Cover page header card (dynamic CHEMTEX / AmperePro document header grid)
 * - Hybrid section rendering:
 *     • Renders populated_tree blocks (paragraphs, tables, field inputs)
 *     • For sections with 0 blocks, seamlessly renders template schema fields
 *     • For template table sections, renders full table with editable cells
 *     • Filters out empty dummy headings (from TOC or cover page)
 * - Real-time verified status updates (editing or saving instantly marks Verified)
 * - Filter by All, Missing, Review, Verified
 * - Instant DOCX and PDF download reflecting all user edits
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { structuralCheck, type StructuralValidationResult } from '../services/api'
import { Pencil, Check, X, RotateCcw, Plus, Trash2 } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || '/api'

// ─── Types ───────────────────────────────────────────────────────────────────

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
  default_value?: string | null
  is_default?: boolean
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
  template_code?: string
  template_name?: string
  status: string
  progress: number
  error_message: string | null
  created_at: string
  completed_at: string | null
  extracted_fields: ExtractedField[]
  populated_tree?: BtTree
}

// ─── Block tree types (populated_tree) ───────────────────────────────────────

interface BtFieldBinding {
  field_id: string
  field_label: string
  value: string | null
  confidence?: number | null
  source_text?: string | null
}

interface BtBlock {
  block_id: string
  block_type: 'paragraph' | 'table' | 'heading' | string
  text?: string | null
  original_text?: string | null
  is_edited?: boolean
  field_binding?: BtFieldBinding | null
  table_data?: string[][] | null
  row_bindings?: Record<string, BtFieldBinding> | null
  cell_bindings?: Record<string, BtFieldBinding> | null
}

interface BtSection {
  section_id: string
  section_number: string | null
  heading_text: string | null
  blocks: BtBlock[]
  subsections: BtSection[]
}

interface BtTree {
  sections: BtSection[]
}

// ─── Template / schema types ──────────────────────────────────────────────────

interface SchemaField {
  field_id: string
  field_label: string
  clause_ref?: string
  data_type?: string
  required?: boolean
  is_dynamic?: boolean
  default_value?: string
}

interface SchemaSection {
  section_id: string
  section_number: string | null
  section_name: string
  field_type?: string
  columns?: string[]
  rows?: { row_id: string; values: string[]; row_label?: string }[]
  fields: SchemaField[]
}

interface SchemaTemplate {
  template_id: string
  template_name: string
  specification_number?: string | null
  version: string
  sections: SchemaSection[]
}

// ─── Filter type ─────────────────────────────────────────────────────────────

type FilterType = 'all' | 'default' | 'review' | 'verified'

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchJob(jobId: string): Promise<ExtractionJob> {
  const r = await fetch(`${API_BASE}/extraction/${jobId}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function fetchTemplate(
  templateId: number,
  templateCode?: string,
  templateName?: string,
): Promise<SchemaTemplate | null> {
  if (templateCode) {
    try {
      const r = await fetch(`${API_BASE}/templates/${templateCode}`, { cache: 'no-store' })
      if (r.ok) {
        const d = await r.json()
        const raw = d.schema ?? d
        return {
          template_id: d.template_id || templateCode,
          template_name: d.template_name || templateName || templateCode,
          specification_number: d.specification_number,
          version: d.version || '1.0',
          sections: raw.sections || [],
        }
      }
    } catch {
      // Fall through to list search
    }
  }

  try {
    const listRes = await fetch(`${API_BASE}/templates`, { cache: 'no-store' })
    if (listRes.ok) {
      const all: any[] = await listRes.json()
      const found = all.find((t: any) => t.id === templateId || t.template_id === templateCode)
      if (found) {
        const raw = found.schema ?? found
        return {
          template_id: found.template_id,
          template_name: found.template_name || templateName || '',
          specification_number: found.specification_number,
          version: found.version || '1.0',
          sections: raw.sections || [],
        }
      }
    }
  } catch {
    // Ignore
  }
  return null
}

async function patchField(jobId: string, fieldId: string, value: string): Promise<void> {
  await fetch(`${API_BASE}/extraction/${jobId}/fields/${fieldId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, validation_status: 'verified' }),
  })
}

async function patchBlockText(jobId: string, blockId: string, text: string): Promise<void> {
  const r = await fetch(`${API_BASE}/extraction/${jobId}/blocks/${encodeURIComponent(blockId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!r.ok) {
    const err = await r.text()
    throw new Error(err || 'Failed to update block text')
  }
}

async function patchBlockTable(jobId: string, blockId: string, table_data: string[][]): Promise<void> {
  const r = await fetch(`${API_BASE}/extraction/${jobId}/blocks/${encodeURIComponent(blockId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table_data }),
  })
  if (!r.ok) {
    const err = await r.text()
    throw new Error(err || 'Failed to update block table data')
  }
}

async function downloadExport(jobId: string, format: 'docx' | 'pdf'): Promise<void> {
  const r = await fetch(`${API_BASE}/extraction/${jobId}/export?format=${format}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(await r.text())
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `specification_${jobId}.${format}`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseSectionName(raw: string): { num: string; title: string } {
  const clean = raw.replace(/\t+/g, ' ').trim()
  const m = clean.match(/^(\d+(?:[\.\s]+\d+)*\.?)\s+(.+)/)
  if (m) {
    const num = m[1].replace(/\s+/g, '.').replace(/\.+/g, '.').replace(/\.$/, '')
    return { num, title: m[2].trim().toUpperCase() }
  }
  return { num: '', title: clean.toUpperCase() }
}

function confidencePct(ef: ExtractedField | BtFieldBinding | undefined): number | null {
  if (!ef) return null
  const c = (ef as any).confidence
  return c != null ? Math.round(c * 100) : null
}

function fieldStatus(
  val: string,
  origExtracted: string,
  confPct: number | null,
  validationStatus?: string | null,
  defaultValue?: string | null,
) {
  const isMissing = !val || val.trim() === ''
  if (isMissing) {
    return { isMissing: true, isDefault: false, isEdited: false, isReview: false, isVerified: false }
  }

  const isEdited = Boolean(
    (origExtracted && val.trim() !== origExtracted.trim() && validationStatus !== 'default') ||
    (validationStatus === 'verified')
  )
  if (isEdited) {
    return { isMissing: false, isDefault: false, isEdited: true, isReview: false, isVerified: true }
  }

  const isDefault = Boolean(
    validationStatus === 'default' ||
    (defaultValue && defaultValue.trim() !== '' && val.trim() === defaultValue.trim() && (!origExtracted || origExtracted.trim() === ''))
  )
  if (isDefault) {
    return { isMissing: false, isDefault: true, isEdited: false, isReview: false, isVerified: false }
  }

  const isReview = confPct != null && confPct < 85
  return { isMissing: false, isDefault: false, isEdited: false, isReview, isVerified: !isReview }
}

function isCoverSection(s: { section_id?: string; section_name?: string; section_number?: string | null; field_type?: string }): boolean {
  const id = (s.section_id || '').toLowerCase()
  const name = (s.section_name || '').toLowerCase()
  const num = (s.section_number || '').trim()
  return (
    s.field_type === 'cover' ||
    id === 'cover' ||
    id === 'cover_page' ||
    name.includes('cover') ||
    num === '0' ||
    num === '0.0'
  )
}

// ─── Field Input Component ────────────────────────────────────────────────────

interface FieldInputProps {
  fieldId: string
  label: string
  value: string
  origExtracted: string
  confidence: number | null
  validationStatus?: string | null
  defaultValue?: string | null
  sourceRef?: SourceReference | null
  onChange: (v: string) => void
  onSave: () => void
  compact?: boolean
}

function FieldInput({
  fieldId,
  label,
  value,
  origExtracted,
  confidence,
  validationStatus,
  defaultValue,
  sourceRef,
  onChange,
  onSave,
  compact = false,
}: FieldInputProps) {
  const [showSrc, setShowSrc] = useState(false)
  const { isMissing, isDefault, isReview, isVerified } = fieldStatus(
    value,
    origExtracted,
    confidence,
    validationStatus,
    defaultValue
  )

  return (
    <div
      id={`field-${fieldId}`}
      className={`rounded-xl border transition-all duration-150 ${
        isMissing
          ? 'bg-red-50/50 border-red-200'
          : isDefault
          ? 'bg-indigo-50/20 border-indigo-200/90 hover:border-indigo-300'
          : isReview
          ? 'bg-amber-50/40 border-amber-200'
          : 'bg-white border-slate-200/90 hover:border-slate-300'
      } ${compact ? 'p-3' : 'p-4'}`}
    >
      {/* Label and Status Badges */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <label className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">
          {label}
        </label>
        <div className="flex items-center gap-1.5 flex-wrap">
          {isDefault && (
            <span
              className="px-2 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full text-[10px] font-bold flex items-center gap-1"
              title="Not found in document — pre-filled with template default value"
            >
              📋 DEFAULT VALUE
            </span>
          )}
          {isMissing && (
            <span className="px-2 py-0.5 bg-red-100 text-red-700 border border-red-200 rounded-full text-[10px] font-bold">
              🔴 MISSING
            </span>
          )}
          {isReview && (
            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 border border-amber-200 rounded-full text-[10px] font-semibold">
              ⚠️ REVIEW
            </span>
          )}
          {isVerified && (
            <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-full text-[10px] font-semibold">
              ✓ VERIFIED
            </span>
          )}
          {confidence != null && (
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                confidence >= 90
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : confidence >= 70
                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-red-50 text-red-700 border-red-200'
              }`}
            >
              {confidence}%
            </span>
          )}
          {sourceRef?.page_number && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium border bg-blue-50 text-blue-700 border-blue-200">
              p.{sourceRef.page_number}
            </span>
          )}
        </div>
      </div>

      {/* Editable Textarea / Input */}
      <textarea
        className={`w-full rounded-lg border px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 resize-y transition-colors min-h-[36px] ${
          isMissing
            ? 'border-red-300 bg-white focus:border-red-500 focus:ring-red-100'
            : isDefault
            ? 'border-indigo-200 bg-indigo-50/15 focus:border-indigo-400 focus:ring-indigo-100 focus:bg-white'
            : 'border-slate-200 bg-slate-50 focus:border-blue-400 focus:ring-blue-100 focus:bg-white'
        }`}
        rows={value.length > 80 ? 3 : 1}
        value={value}
        placeholder={isMissing ? '— Missing value — enter manually' : ''}
        onChange={e => onChange(e.target.value)}
        onBlur={onSave}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSave()
          }
        }}
      />

      {/* Default Notice for the user */}
      {isDefault && (
        <p className="text-[11px] text-indigo-700 mt-1.5 flex items-center gap-1.5 font-sans">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
          <span>Using template default value (not extracted from uploaded document). You can keep or edit it.</span>
        </p>
      )}

      {/* Source Reference Toggle */}
      {sourceRef?.source_text && (
        <div className="mt-1.5">
          <button
            onClick={() => setShowSrc(v => !v)}
            className="text-[11px] text-blue-600 hover:text-blue-800 font-medium"
          >
            🔍 {showSrc ? 'Hide' : 'Show'} source
          </button>
          {showSrc && (
            <div className="mt-1 p-2.5 bg-slate-100 border border-slate-200 rounded-lg text-[11px] font-mono text-slate-700 whitespace-pre-wrap">
              <span className="text-[10px] font-sans font-bold text-slate-500 uppercase block mb-0.5">
                Source (p.{sourceRef.page_number ?? '?'})
              </span>
              "{sourceRef.source_text}"
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Cover Page Editor (exact two-table layout) ───────────────────────────────

interface CoverPageCardProps {
  coverSection: SchemaSection | null
  preambleBlocks: BtBlock[]
  extractedMap: Map<string, ExtractedField>
  fieldValues: Record<string, string>
  onFieldChange: (fid: string, v: string) => void
  onSave: (fid: string) => void
  jobId: string
}

const REV_TABLE_COLUMNS = ['REV', "DESCRIPTION", "PREP'D", 'CKD', "APPR'D", 'DATE']
const REV_COL_WIDTHS = ['5%', '40%', '12%', '10%', '12%', '17%']

function CoverPageCard({
  coverSection,
  preambleBlocks,
  extractedMap,
  fieldValues,
  onFieldChange,
  onSave,
  jobId,
}: CoverPageCardProps) {
  // ── Field resolution ──────────────────────────────────────────────────────
  const resolveField = useCallback(
    (candidates: string[]): { fid: string; label: string } => {
      for (const cand of candidates) {
        if (extractedMap.has(cand)) return { fid: cand, label: extractedMap.get(cand)!.field_label }
      }
      if (coverSection?.fields) {
        for (const f of coverSection.fields) {
          const fidL = f.field_id.toLowerCase()
          const lblL = f.field_label.toLowerCase()
          if (candidates.some(c => fidL.includes(c) || lblL.includes(c)))
            return { fid: f.field_id, label: f.field_label }
        }
      }
      return { fid: candidates[0], label: candidates[0].replace(/_/g, ' ').toUpperCase() }
    },
    [extractedMap, coverSection]
  )

  const company  = resolveField(['client_name', 'chemtex_hdr_2', 'company', 'client'])
  const specNo   = resolveField(['spec_no', 'spec_no_hdr_1', 'specification_number', 'spec_number'])
  const revField = resolveField(['revision', 'rev_no', 'rev'])
  const projNo   = resolveField(['project_no', 'project_no_hdr_3', 'project_number', 'project_code'])
  const sheetNo  = resolveField(['sheet_no', 'sheet', 'sheets_total', 'sheet_number'])
  const area     = resolveField(['area', 'area_hdr_4'])
  const desc     = resolveField(['description', 'description_hdr_5', 'doc_title', 'title'])

  const getVal = (f: { fid: string }) => {
    const ef = extractedMap.get(f.fid)
    return fieldValues[f.fid] ?? ef?.value ?? ef?.default_value ?? ''
  }

  // Fallbacks from preamble for display
  const displayCompany = getVal(company)  || preambleBlocks[3]?.text || 'CHEMTEX'
  const displayProjNo  = getVal(projNo)   || preambleBlocks[0]?.text || ''
  const displayDesc    = getVal(desc)     || preambleBlocks[2]?.text || ''

  // ── Header cell helper ────────────────────────────────────────────────────
  function HCell({
    label,
    fid,
    placeholder = '',
    bold = false,
    className = '',
  }: {
    label: string
    fid: string
    placeholder?: string
    bold?: boolean
    className?: string
  }) {
    const ef = extractedMap.get(fid)
    const val = fieldValues[fid] ?? ef?.value ?? ef?.default_value ?? ''
    const { isDefault } = fieldStatus(
      val,
      ef?.original_value ?? ef?.value ?? '',
      confidencePct(ef),
      ef?.validation_status,
      ef?.default_value ?? ''
    )
    return (
      <td className={`border border-slate-400 px-2 py-1.5 align-top ${className}`}>
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">{label}</span>
          {isDefault && (
            <span className="px-1 bg-indigo-50 text-indigo-600 border border-indigo-200 rounded text-[8px] font-bold leading-none py-0.5">
              DEFAULT
            </span>
          )}
        </div>
        <input
          type="text"
          className={`w-full text-xs bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none transition-colors py-0.5 ${bold ? 'font-extrabold text-blue-900' : 'font-semibold text-slate-900'}`}
          value={val || placeholder}
          placeholder={placeholder}
          onChange={e => onFieldChange(fid, e.target.value)}
          onBlur={() => onSave(fid)}
        />
      </td>
    )
  }

  // ── Revision history table ─────────────────────────────────────────────────
  // Try to find a table block in preamble blocks (the cover revision table)
  const revTableBlock = useMemo(
    () => preambleBlocks.find(b => b.block_type === 'table' && b.table_data && b.table_data.length > 0) ?? null,
    [preambleBlocks]
  )

  // Seed rows from preamble table block (skip header row if it matches columns)
  const seedRows = useMemo<string[][]>(() => {
    if (!revTableBlock?.table_data) return [['', '', '', '', '', '']]
    const rows = revTableBlock.table_data
    // Detect if first row is a column header (contains 'REV' or 'DESCRIPTION')
    const firstRowText = (rows[0] || []).join('').toUpperCase()
    const isHeader = firstRowText.includes('REV') || firstRowText.includes('DESCRIPTION')
    const dataRows = isHeader ? rows.slice(1) : rows
    if (dataRows.length === 0) return [['', '', '', '', '', '']]
    // Pad/trim each row to 6 columns
    return dataRows.map(r => {
      const padded = [...r]
      while (padded.length < 6) padded.push('')
      return padded.slice(0, 6)
    })
  }, [revTableBlock])

  const [revRows, setRevRows] = useState<string[][]>(seedRows)
  const revRowsRef = React.useRef(revRows)
  revRowsRef.current = revRows

  // Keep in sync if preamble data reloads
  useEffect(() => { setRevRows(seedRows) }, [seedRows])

  const persistRevTable = useCallback(async (rows: string[][]) => {
    if (!revTableBlock?.block_id) return
    // Build full table_data: header row + data rows
    const full = [REV_TABLE_COLUMNS, ...rows]
    try {
      await patchBlockTable(jobId, revTableBlock.block_id, full)
    } catch (err) {
      console.warn('Cover revision table save failed:', err)
    }
  }, [jobId, revTableBlock])

  const handleRevCellChange = (ri: number, ci: number, val: string) => {
    setRevRows(prev => {
      const next = prev.map((r, rIdx) => {
        if (rIdx !== ri) return r
        const newR = [...r]; newR[ci] = val; return newR
      })
      revRowsRef.current = next
      return next
    })
  }

  const handleRevCellBlur = () => {
    void persistRevTable(revRowsRef.current)
  }

  const handleAddRevRow = () => {
    const newRow = ['', '', '', '', '', '']
    const updated = [...revRowsRef.current, newRow]
    setRevRows(updated)
    revRowsRef.current = updated
    void persistRevTable(updated)
  }

  const handleDeleteRevRow = (ri: number) => {
    if (revRowsRef.current.length <= 1) return
    const updated = revRowsRef.current.filter((_, idx) => idx !== ri)
    setRevRows(updated)
    revRowsRef.current = updated
    void persistRevTable(updated)
  }

  // ── "Other" cover fields not covered by the main grid ────────────────────
  const mainGridFids = new Set([
    company.fid, specNo.fid, revField.fid, projNo.fid, sheetNo.fid, area.fid, desc.fid
  ])
  const otherCoverFields = (coverSection?.fields || []).filter(f => !mainGridFids.has(f.field_id))

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="bg-white rounded-2xl border border-slate-300 shadow-sm overflow-hidden mb-6">
      {/* ── Title bar ── */}
      <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-bold text-slate-700 uppercase tracking-widest">
            Cover Page — Project Specification Header
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Edit any cell — changes save on blur and reflect in DOCX/PDF export.
          </p>
        </div>
        <span className="px-2.5 py-1 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg text-[10px] font-bold uppercase tracking-wider">
          Cover Page
        </span>
      </div>

      <div className="p-4 space-y-4">
        {/* ── Table 1: Header metadata (exact replica of cover page top table) ── */}
        <div>
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
            Document Header
          </p>
          <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '30%' }} />
              <col style={{ width: '45%' }} />
              <col style={{ width: '25%' }} />
            </colgroup>
            <tbody>
              {/* Row 1: COMPANY (rowspan 2) | SPEC NO | REV */}
              <tr>
                <td rowSpan={2} className="border border-slate-400 px-2 py-1.5 align-middle text-center bg-slate-50/60">
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Company / Client</span>
                    <input
                      type="text"
                      className="w-full text-sm font-extrabold text-center text-blue-900 bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none transition-colors py-0.5"
                      value={getVal(company) || displayCompany}
                      placeholder="CHEMTEX"
                      onChange={e => onFieldChange(company.fid, e.target.value)}
                      onBlur={() => onSave(company.fid)}
                    />
                  </div>
                </td>
                <HCell label="SPEC. NO" fid={specNo.fid} placeholder="IP009-43-03-01" />
                <HCell label="REV." fid={revField.fid} placeholder="P" />
              </tr>
              {/* Row 2: (company rowspan continues) | PROJECT NO | SH. */}
              <tr>
                <HCell label="PROJECT NO" fid={projNo.fid} placeholder={displayProjNo} />
                <HCell label="SH." fid={sheetNo.fid} placeholder="1 OF 19" />
              </tr>
              {/* Row 3: AREA | DESCRIPTION (colspan 2) */}
              <tr>
                <HCell label="AREA" fid={area.fid} placeholder="ELECTRICAL" />
                <td className="border border-slate-400 px-2 py-1.5 align-top" colSpan={2}>
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">DESCRIPTION</span>
                  </div>
                  <input
                    type="text"
                    className="w-full text-xs font-semibold text-slate-900 bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none transition-colors py-0.5"
                    value={getVal(desc) || displayDesc}
                    placeholder="6.6kV SWITCHBOARD"
                    onChange={e => onFieldChange(desc.fid, e.target.value)}
                    onBlur={() => onSave(desc.fid)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* ── Table 2: Revision History ── */}
        <div>
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
            Revision History
          </p>
          <div className="overflow-hidden rounded-lg border border-slate-300">
            <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                {REV_COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}
                <col style={{ width: '36px' }} />
              </colgroup>
              <thead>
                <tr className="bg-slate-700 text-white">
                  {REV_TABLE_COLUMNS.map((col, ci) => (
                    <th key={ci} className="px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider border-r border-slate-600 last:border-0">
                      {col}
                    </th>
                  ))}
                  <th className="px-1 py-1.5 text-center text-[10px] font-bold text-slate-400 border-l border-slate-600 uppercase tracking-wider">
                    ✕
                  </th>
                </tr>
              </thead>
              <tbody>
                {revRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-[11px] text-slate-400 italic">
                      No revision rows yet. Click "+ Add Row" to add the first entry.
                    </td>
                  </tr>
                ) : (
                  revRows.map((row, ri) => (
                    <tr key={ri} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                      {REV_TABLE_COLUMNS.map((col, ci) => (
                        <td key={ci} className="p-1 border-r border-slate-100 last:border-0">
                          <input
                            type="text"
                            className="w-full px-1.5 py-1 text-xs text-slate-800 bg-white border border-slate-200 rounded hover:border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
                            value={row[ci] ?? ''}
                            placeholder={col}
                            onChange={e => handleRevCellChange(ri, ci, e.target.value)}
                            onBlur={handleRevCellBlur}
                          />
                        </td>
                      ))}
                      <td className="p-1 text-center">
                        <button
                          type="button"
                          onClick={() => handleDeleteRevRow(ri)}
                          title="Delete this revision row"
                          className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5 mx-auto" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
              <button
                type="button"
                onClick={handleAddRevRow}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-600 bg-white hover:bg-blue-50 rounded-lg border border-blue-200 transition-colors shadow-2xs"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Row
              </button>
              <span className="text-[10px] text-slate-400 font-medium">
                {revRows.length} {revRows.length === 1 ? 'revision' : 'revisions'}
                {!revTableBlock && (
                  <span className="ml-2 text-amber-500" title="No table block found in populated tree — rows won't persist to server until a cover table block is detected">⚠ No linked block</span>
                )}
              </span>
            </div>
          </div>
        </div>

        {/* ── Additional cover fields ── */}
        {otherCoverFields.length > 0 && (
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              Additional Cover Properties
            </p>
            <div className="grid grid-cols-2 gap-3">
              {otherCoverFields.map(f => {
                const ef = extractedMap.get(f.field_id)
                const defVal = ef?.default_value ?? f.default_value ?? ''
                const val = fieldValues[f.field_id] ?? ef?.value ?? defVal
                return (
                  <FieldInput
                    key={f.field_id}
                    fieldId={f.field_id}
                    label={f.field_label}
                    value={val}
                    origExtracted={ef?.original_value ?? ef?.value ?? ''}
                    confidence={confidencePct(ef)}
                    validationStatus={ef?.validation_status}
                    defaultValue={defVal}
                    sourceRef={ef?.source_references?.[0] ?? null}
                    onChange={v => onFieldChange(f.field_id, v)}
                    onSave={() => onSave(f.field_id)}
                    compact={true}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Editable Static Paragraph Component ─────────────────────────────────────

interface EditableStaticParagraphProps {
  block: BtBlock
  jobId: string
  onBlockUpdate?: (blockId: string, newText: string) => void
  highlightEditable?: boolean
}

function EditableStaticParagraph({
  block,
  jobId,
  onBlockUpdate,
  highlightEditable = false,
}: EditableStaticParagraphProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draftText, setDraftText] = useState(block.text || '')
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const isEdited = Boolean(block.is_edited || (block.original_text && block.text !== block.original_text))

  useEffect(() => {
    setDraftText(block.text || '')
  }, [block.text])

  const handleSave = async () => {
    if (!draftText.trim()) return
    setSaving(true)
    try {
      await patchBlockText(jobId, block.block_id, draftText)
      onBlockUpdate?.(block.block_id, draftText)
      setIsEditing(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2500)
    } catch (err) {
      console.error('Failed to update static paragraph:', err)
      alert(`Failed to save: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!block.original_text) return
    if (!window.confirm('Reset this paragraph back to its original template text?')) return
    setSaving(true)
    try {
      await patchBlockText(jobId, block.block_id, block.original_text)
      setDraftText(block.original_text)
      onBlockUpdate?.(block.block_id, block.original_text)
      setIsEditing(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2500)
    } catch (err) {
      console.error('Failed to reset static paragraph:', err)
      alert(`Failed to reset: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setDraftText(block.text || '')
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <div className="my-2 p-3 bg-blue-50/40 border-2 border-blue-400/80 rounded-xl shadow-xs transition-all">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-blue-900">
            <Pencil className="w-3.5 h-3.5 text-blue-600" />
            <span>Editing Static Paragraph</span>
          </div>
          {block.original_text && block.original_text !== draftText && (
            <button
              type="button"
              onClick={handleReset}
              disabled={saving}
              className="text-[11px] font-medium text-slate-500 hover:text-amber-700 flex items-center gap-1 px-2 py-0.5 rounded hover:bg-amber-50 transition-colors"
              title="Revert to original template text"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to original
            </button>
          )}
        </div>
        <textarea
          value={draftText}
          onChange={e => setDraftText(e.target.value)}
          rows={Math.max(2, Math.min(8, Math.ceil((draftText.length || 1) / 75)))}
          className="w-full p-2.5 text-xs font-sans text-slate-800 bg-white border border-blue-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent leading-relaxed"
          placeholder="Enter paragraph text..."
          autoFocus
        />
        <div className="flex items-center justify-end gap-2 mt-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-800 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" />
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !draftText.trim()}
            className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg shadow-xs transition-colors flex items-center gap-1"
          >
            {saving ? (
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            Save Changes
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`group relative rounded-lg py-1 px-1.5 transition-all flex items-start justify-between gap-3 ${
        highlightEditable
          ? 'bg-blue-50/20 hover:bg-blue-50/50 border border-dashed border-blue-300 hover:border-blue-500'
          : 'hover:bg-slate-100/70 border border-transparent hover:border-slate-200'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-xs text-slate-700 leading-relaxed font-sans select-text">
          {block.text}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          {isEdited && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
              ✓ Edited static text
            </span>
          )}
          {saveSuccess && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">
              ✓ Saved
            </span>
          )}
        </div>
      </div>

      <div className={`flex-shrink-0 flex items-center gap-1 transition-opacity ${highlightEditable ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        <button
          type="button"
          onClick={() => setIsEditing(true)}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 hover:border-blue-300 rounded shadow-2xs transition-colors"
          title="Edit this static text"
        >
          <Pencil className="w-3 h-3" />
          <span>Edit</span>
        </button>
      </div>
    </div>
  )
}

// ─── Block Renderer Component ─────────────────────────────────────────────────

interface BlockRendererProps {
  block: BtBlock
  jobId: string
  extractedMap: Map<string, ExtractedField>
  fieldValues: Record<string, string>
  activeFilter: FilterType
  onFieldChange: (fid: string, v: string) => void
  onSave: (fid: string) => void
  onBlockUpdate?: (blockId: string, newText: string) => void
  onBlockTableUpdate?: (blockId: string, newTableData: string[][]) => void
  enableStaticEditing?: boolean
}

// ─── EditableTableBlock Component ─────────────────────────────────────────────

interface EditableTableBlockProps {
  block: BtBlock
  jobId: string
  extractedMap: Map<string, ExtractedField>
  fieldValues: Record<string, string>
  onFieldChange: (fid: string, v: string) => void
  onSave: (fid: string) => void
  onBlockTableUpdate?: (blockId: string, newTableData: string[][]) => void
  activeFilter: FilterType
}

function EditableTableBlock({
  block,
  jobId,
  extractedMap,
  fieldValues,
  onFieldChange,
  onSave,
  onBlockTableUpdate,
  activeFilter,
}: EditableTableBlockProps) {
  const initialData = useMemo(() => block.table_data || [], [block.table_data])
  const [tableData, setTableData] = useState<string[][]>(initialData)
  const tableDataRef = React.useRef(tableData)
  tableDataRef.current = tableData

  // Sync with block.table_data when parent updates
  useEffect(() => {
    if (block.table_data) {
      setTableData(block.table_data)
    }
  }, [block.table_data])

  if (!tableData || tableData.length === 0) return null

  const headers = tableData[0] || []
  const dataRows = tableData.slice(1)

  // Filter logic: if activeFilter !== 'all', check if any cell matches
  if (activeFilter !== 'all') {
    let matchesFilter = false
    for (let ri = 1; ri < tableData.length; ri++) {
      const rowIdx = ri
      const rb = block.row_bindings?.[String(rowIdx)]
      for (let ci = 0; ci < tableData[ri].length; ci++) {
        const cbKey = `${rowIdx},${ci}`
        const cb = block.cell_bindings?.[cbKey] || (ci === 1 ? rb : null)
        if (cb?.field_id) {
          const ef = extractedMap.get(cb.field_id)
          const defVal = ef?.default_value ?? ''
          const val = fieldValues[cb.field_id] ?? ef?.value ?? (defVal || tableData[ri][ci])
          const orig = ef?.original_value ?? ef?.value ?? ''
          const { isDefault, isReview, isVerified } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)
          if (activeFilter === 'default' && isDefault) matchesFilter = true
          if (activeFilter === 'review' && isReview) matchesFilter = true
          if (activeFilter === 'verified' && isVerified) matchesFilter = true
        }
      }
    }
    if (!matchesFilter) return null
  }

  const isCol0Serial = headers[0]?.toLowerCase().includes('no') ||
                       headers[0]?.toLowerCase().includes('sl') ||
                       headers[0]?.toLowerCase().includes('s.')

  const handleCellChange = (rowIdx: number, ci: number, newVal: string, fid?: string) => {
    setTableData(prev => {
      const next = prev.map((r, rIdx) => {
        if (rIdx !== rowIdx) return r
        const newRow = [...r]
        newRow[ci] = newVal
        return newRow
      })
      tableDataRef.current = next
      return next
    })

    if (fid) {
      onFieldChange(fid, newVal)
    }
  }

  const handleCellBlur = (fid?: string) => {
    if (fid) {
      onSave(fid)
    }
    if (onBlockTableUpdate) {
      onBlockTableUpdate(block.block_id, tableDataRef.current)
    }
  }

  const handleAddRow = () => {
    const colCount = headers.length || 4
    const newRow = Array(colCount).fill('')
    if (isCol0Serial) {
      newRow[0] = String(tableData.length) // next serial number
    }
    const updated = [...tableData, newRow]
    setTableData(updated)
    tableDataRef.current = updated
    if (onBlockTableUpdate) {
      onBlockTableUpdate(block.block_id, updated)
    }
  }

  const handleDeleteRow = (rowIdx: number) => {
    if (tableData.length <= 1) return
    let updated = tableData.filter((_, idx) => idx !== rowIdx)
    if (isCol0Serial) {
      updated = updated.map((r, idx) => {
        if (idx === 0) return r
        // If column 0 is a number, renumber it
        if (!isNaN(Number(r[0])) || r[0] === '') {
          const renumbered = [...r]
          renumbered[0] = String(idx)
          return renumbered
        }
        return r
      })
    }
    setTableData(updated)
    tableDataRef.current = updated
    if (onBlockTableUpdate) {
      onBlockTableUpdate(block.block_id, updated)
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm my-3">
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-slate-800 text-white text-[11px] font-bold">
              {headers.map((cell, ci) => (
                <th key={ci} className="px-3 py-2 text-left border-r border-slate-700 last:border-0 uppercase tracking-wider">
                  {cell || `Col ${ci + 1}`}
                </th>
              ))}
              <th className="px-2 py-2 text-center w-12 border-l border-slate-700 uppercase tracking-wider text-slate-400 font-semibold">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {dataRows.length === 0 ? (
              <tr>
                <td colSpan={headers.length + 1} className="py-5 text-center text-xs text-slate-400 italic">
                  No rows in this table. Click "+ Add Row" to insert a row.
                </td>
              </tr>
            ) : (
              dataRows.map((row, ri) => {
                const rowIdx = ri + 1
                const rb = block.row_bindings?.[String(rowIdx)]
                return (
                  <tr key={ri} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                    {headers.map((_, ci) => {
                      const cbKey = `${rowIdx},${ci}`
                      const cb = block.cell_bindings?.[cbKey] || (ci === 1 ? rb : null)
                      const fid = cb?.field_id
                      const ef = fid ? extractedMap.get(fid) : null
                      const defVal = ef?.default_value ?? ''
                      const cellVal = fid
                        ? (fieldValues[fid] ?? ef?.value ?? (defVal || row[ci] || ''))
                        : (row[ci] ?? '')
                      const isDef = fid ? (ef?.validation_status === 'default' || (Boolean(defVal) && cellVal === defVal && (!ef || !ef.original_value))) : false

                      return (
                        <td key={ci} className="p-1.5 border-r border-slate-100 last:border-0">
                          <input
                            type="text"
                            className={`w-full px-2 py-1.5 text-xs rounded transition-all focus:outline-none focus:ring-1 ${
                              isDef
                                ? 'bg-indigo-50/50 text-indigo-900 border border-indigo-300 focus:ring-indigo-500 font-medium'
                                : 'bg-white text-slate-800 border border-slate-200 hover:border-slate-300 focus:border-blue-500 focus:ring-blue-500'
                            }`}
                            value={cellVal}
                            placeholder={headers[ci] ? `Enter ${headers[ci]}...` : ''}
                            onChange={e => handleCellChange(rowIdx, ci, e.target.value, fid)}
                            onBlur={() => handleCellBlur(fid)}
                            title={isDef ? 'Using template default value' : undefined}
                          />
                        </td>
                      )
                    })}
                    <td className="p-1.5 text-center w-12 border-l border-slate-100">
                      <button
                        type="button"
                        onClick={() => handleDeleteRow(rowIdx)}
                        title="Delete this row"
                        className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5 mx-auto" />
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between">
        <button
          type="button"
          onClick={handleAddRow}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-600 bg-white hover:bg-blue-50 rounded-lg border border-blue-200 transition-colors shadow-2xs"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Row</span>
        </button>
        <span className="text-[11px] text-slate-400 font-medium">
          {dataRows.length} {dataRows.length === 1 ? 'row' : 'rows'}
        </span>
      </div>
    </div>
  )
}

function BlockRenderer({
  block,
  jobId,
  extractedMap,
  fieldValues,
  activeFilter,
  onFieldChange,
  onSave,
  onBlockUpdate,
  onBlockTableUpdate,
  enableStaticEditing,
}: BlockRendererProps) {
  const { block_type, text, field_binding, table_data } = block

  // 1. Field-bound paragraph
  if (field_binding?.field_id) {
    const fid = field_binding.field_id
    const ef = extractedMap.get(fid)
    const defVal = ef?.default_value ?? ''
    const val = fieldValues[fid] ?? ef?.value ?? (defVal || field_binding.value || '')
    const orig = ef?.original_value ?? ef?.value ?? ''
    const { isDefault, isReview, isVerified } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)

    if (activeFilter === 'default' && !isDefault) return null
    if (activeFilter === 'review' && !isReview) return null
    if (activeFilter === 'verified' && !isVerified) return null

    return (
      <FieldInput
        fieldId={fid}
        label={field_binding.field_label || fid}
        value={val}
        origExtracted={orig}
        confidence={confidencePct(ef)}
        validationStatus={ef?.validation_status}
        defaultValue={defVal}
        sourceRef={ef?.source_references?.[0] ?? null}
        onChange={v => onFieldChange(fid, v)}
        onSave={() => onSave(fid)}
      />
    )
  }

  // 2. Table block (All cells editable + Add/Delete rows + Instant persistence)
  if (block_type === 'table' && table_data && table_data.length > 0) {
    return (
      <EditableTableBlock
        block={block}
        jobId={jobId}
        extractedMap={extractedMap}
        fieldValues={fieldValues}
        onFieldChange={onFieldChange}
        onSave={onSave}
        onBlockTableUpdate={onBlockTableUpdate}
        activeFilter={activeFilter}
      />
    )
  }

  // 3. Regular document text paragraph (with optional inline editing)
  if (text && text.trim()) {
    if (activeFilter !== 'all') return null
    return (
      <EditableStaticParagraph
        block={block}
        jobId={jobId}
        onBlockUpdate={onBlockUpdate}
        highlightEditable={enableStaticEditing}
      />
    )
  }

  return null
}

// ─── BtSectionCard Component ──────────────────────────────────────────────────

interface BtSectionCardProps {
  sec: BtSection
  level?: number
  jobId: string
  extractedMap: Map<string, ExtractedField>
  fieldValues: Record<string, string>
  activeFilter: FilterType
  searchQuery: string
  onFieldChange: (fid: string, v: string) => void
  onSave: (fid: string) => void
  onSaveSection: (fieldIds: string[]) => Promise<void>
  onBlockUpdate?: (blockId: string, newText: string) => void
  onBlockTableUpdate?: (blockId: string, newTableData: string[][]) => void
  enableStaticEditing?: boolean
  saving: boolean
  expanded: boolean
  onToggle: () => void
  matchedTemplateSec?: SchemaSection | null
}

function BtSectionCard({
  sec,
  level = 0,
  jobId,
  extractedMap,
  fieldValues,
  activeFilter,
  searchQuery,
  onFieldChange,
  onSave,
  onSaveSection,
  onBlockUpdate,
  onBlockTableUpdate,
  enableStaticEditing,
  saving,
  expanded,
  onToggle,
  matchedTemplateSec,
}: BtSectionCardProps) {
  const headingText = sec.heading_text || 'Section'
  const { num, title } = parseSectionName(sec.section_number ? `${sec.section_number} ${headingText}` : headingText)

  // Collect all field IDs in this section and its subsections
  const fieldIds = useMemo(() => {
    const ids: string[] = []
    function gather(s: BtSection) {
      for (const b of s.blocks) {
        if (b.field_binding?.field_id) ids.push(b.field_binding.field_id)
        if (b.row_bindings) {
          for (const rb of Object.values(b.row_bindings)) {
            if (rb.field_id) ids.push(rb.field_id)
          }
        }
        if (b.cell_bindings) {
          for (const cb of Object.values(b.cell_bindings)) {
            if (cb.field_id) ids.push(cb.field_id)
          }
        }
      }
      s.subsections.forEach(gather)
    }
    gather(sec)
    // If no block bindings, include matched template fields
    if (ids.length === 0 && matchedTemplateSec?.fields) {
      ids.push(...matchedTemplateSec.fields.map(f => f.field_id))
    }
    // Also include matched template table row cells
    if (ids.length === 0 && matchedTemplateSec?.rows) {
      for (const r of matchedTemplateSec.rows) {
        for (let ci = 0; ci < (r.values ?? []).length; ci++) {
          ids.push(`${matchedTemplateSec.section_id}__${r.row_id}__col${ci}`)
        }
      }
    }
    return Array.from(new Set(ids))
  }, [sec, matchedTemplateSec])

  // Count default fields for badge
  const defaultCount = useMemo(() => {
    return fieldIds.filter(fid => {
      const ef = extractedMap.get(fid)
      const defVal = ef?.default_value ?? ''
      const val = fieldValues[fid] ?? ef?.value ?? defVal
      const orig = ef?.original_value ?? ef?.value ?? ''
      const { isDefault } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)
      return isDefault
    }).length
  }, [fieldIds, fieldValues, extractedMap])

  // Check if section contains any field matching the active filter
  const hasMatchingFilterField = useMemo(() => {
    if (activeFilter === 'all') return true
    for (const fid of fieldIds) {
      const ef = extractedMap.get(fid)
      const defVal = ef?.default_value ?? ''
      const val = fieldValues[fid] ?? ef?.value ?? defVal
      const orig = ef?.original_value ?? ef?.value ?? ''
      const { isDefault, isReview, isVerified } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)
      if (activeFilter === 'default' && isDefault) return true
      if (activeFilter === 'review' && isReview) return true
      if (activeFilter === 'verified' && isVerified) return true
    }
    return false
  }, [fieldIds, activeFilter, fieldValues, extractedMap])

  if (!hasMatchingFilterField) return null

  // Filter check
  const matchesSearch =
    !searchQuery ||
    title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    num.includes(searchQuery) ||
    fieldIds.some(fid => {
      const ef = extractedMap.get(fid)
      return (
        fid.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (ef?.field_label || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (fieldValues[fid] || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    })

  if (!matchesSearch) return null

  // If section has 0 blocks and 0 subsections and NO template fields or rows, hide it!
  const hasContent =
    sec.blocks.length > 0 ||
    sec.subsections.length > 0 ||
    (matchedTemplateSec && (matchedTemplateSec.fields.length > 0 || (matchedTemplateSec.rows && matchedTemplateSec.rows.length > 0)))
  if (!hasContent) return null

  const isChild = level > 0

  return (
    <div className={`rounded-2xl border transition-all ${
      isChild ? 'border-slate-200/80 bg-white ml-3 shadow-none' : 'border-slate-200 bg-white shadow-sm overflow-hidden'
    }`}>
      {/* Header button */}
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center justify-between text-left transition-colors ${
          isChild ? 'px-4 py-2.5 hover:bg-slate-50/80' : 'px-5 py-3.5 hover:bg-slate-50/60'
        }`}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {num ? (
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center shadow-sm">
              {num.split('.')[0]}
            </span>
          ) : (
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-slate-400 text-white text-[11px] font-bold flex items-center justify-center">
              §
            </span>
          )}
          <span className={`font-bold text-slate-900 uppercase tracking-wide truncate ${isChild ? 'text-xs' : 'text-sm'}`}>
            {num ? `${num}   ${title}` : title}
          </span>
          {defaultCount > 0 && (
            <span className="flex-shrink-0 px-2 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full text-[10px] font-bold">
              {defaultCount} default
            </span>
          )}
        </div>

        <svg
          className={`w-4 h-4 text-slate-400 transition-transform duration-200 ml-3 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Section body */}
      {expanded && (
        <div className="border-t border-slate-100 px-5 py-4 bg-slate-50/20 space-y-3">
          {/* Render blocks if available */}
          {sec.blocks.map(block => (
            <BlockRenderer
              key={block.block_id}
              block={block}
              jobId={jobId}
              extractedMap={extractedMap}
              fieldValues={fieldValues}
              activeFilter={activeFilter}
              onFieldChange={onFieldChange}
              onSave={onSave}
              onBlockUpdate={onBlockUpdate}
              onBlockTableUpdate={onBlockTableUpdate}
              enableStaticEditing={enableStaticEditing}
            />
          ))}

          {/* If section blocks are empty, render matched template fields! */}
          {sec.blocks.length === 0 && matchedTemplateSec?.fields && matchedTemplateSec.fields.length > 0 && (
            <div className="space-y-3">
              {matchedTemplateSec.fields.map(field => {
                const ef = extractedMap.get(field.field_id)
                const orig = ef?.original_value ?? ''
                const defVal = ef?.default_value ?? field.default_value ?? ''
                const val = fieldValues[field.field_id] ?? ef?.value ?? defVal ?? ''
                const { isDefault, isReview, isVerified } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)

                if (activeFilter === 'default' && !isDefault) return null
                if (activeFilter === 'review' && !isReview) return null
                if (activeFilter === 'verified' && !isVerified) return null

                return (
                  <FieldInput
                    key={field.field_id}
                    fieldId={field.field_id}
                    label={field.field_label}
                    value={val}
                    origExtracted={orig}
                    confidence={confidencePct(ef)}
                    validationStatus={ef?.validation_status}
                    defaultValue={defVal}
                    sourceRef={ef?.source_references?.[0] ?? null}
                    onChange={v => onFieldChange(field.field_id, v)}
                    onSave={() => onSave(field.field_id)}
                  />
                )
              })}
            </div>
          )}

          {/* If section blocks are empty, render matched template table if present! */}
          {sec.blocks.length === 0 && matchedTemplateSec?.rows && matchedTemplateSec.rows.length > 0 && matchedTemplateSec.columns && (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm my-2">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-800 text-white text-[11px] font-bold">
                    {matchedTemplateSec.columns.map((col, ci) => (
                      <th key={ci} className="px-3 py-2 text-left border-r border-slate-700 last:border-0 uppercase tracking-wider">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matchedTemplateSec.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-slate-100 last:border-0 hover:bg-blue-50/20">
                      {row.values.map((cell, ci) => {
                        const cellFid = `${matchedTemplateSec.section_id}__${row.row_id}__col${ci}`
                        const ef = extractedMap.get(cellFid)
                        const defVal = ef?.default_value ?? cell ?? ''
                        const val = fieldValues[cellFid] ?? ef?.value ?? defVal
                        const isDef = ef?.validation_status === 'default' || (Boolean(defVal) && val === defVal && (!ef || !ef.original_value))

                        return (
                          <td key={ci} className="p-2 border-r border-slate-100 last:border-0">
                            <input
                              className={`w-full px-2 py-1 text-xs font-semibold rounded focus:outline-none focus:ring-1 ${
                                isDef
                                  ? 'bg-indigo-50/50 text-indigo-900 border border-indigo-300 focus:ring-indigo-500'
                                  : 'bg-white text-slate-900 border border-slate-200 focus:ring-blue-500'
                              }`}
                              value={val}
                              onChange={e => onFieldChange(cellFid, e.target.value)}
                              onBlur={() => onSave(cellFid)}
                              title={isDef ? 'Using template default value' : undefined}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Subsections */}
          {sec.subsections.length > 0 && (
            <div className="space-y-3 pt-2">
              {sec.subsections.map(sub => (
                <BtSectionCard
                  key={sub.section_id}
                  sec={sub}
                  level={level + 1}
                  jobId={jobId}
                  extractedMap={extractedMap}
                  fieldValues={fieldValues}
                  activeFilter={activeFilter}
                  searchQuery={searchQuery}
                  onFieldChange={onFieldChange}
                  onSave={onSave}
                  onSaveSection={onSaveSection}
                  onBlockUpdate={onBlockUpdate}
                  onBlockTableUpdate={onBlockTableUpdate}
                  enableStaticEditing={enableStaticEditing}
                  saving={saving}
                  expanded={true}
                  onToggle={() => {}}
                />
              ))}
            </div>
          )}

          {/* Section Save footer */}
          {fieldIds.length > 0 && (
            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                disabled={saving}
                onClick={() => void onSaveSection(fieldIds)}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-xl text-xs font-semibold shadow-sm transition-colors"
              >
                {saving ? 'Saving…' : '✓ Save Section'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Template Section Card Component (for pure schema sections or tables) ──────

interface TmplSectionCardProps {
  sec: SchemaSection
  extractedMap: Map<string, ExtractedField>
  fieldValues: Record<string, string>
  activeFilter: FilterType
  searchQuery: string
  onFieldChange: (fid: string, v: string) => void
  onSave: (fid: string) => void
  onSaveSection: (fieldIds: string[]) => Promise<void>
  saving: boolean
  expanded: boolean
  onToggle: () => void
}

function TmplSectionCard({
  sec,
  extractedMap,
  fieldValues,
  activeFilter,
  searchQuery,
  onFieldChange,
  onSave,
  onSaveSection,
  saving,
  expanded,
  onToggle,
}: TmplSectionCardProps) {
  const { num, title } = parseSectionName(sec.section_number ? `${sec.section_number} ${sec.section_name}` : sec.section_name)
  const [tmplRows, setTmplRows] = useState(sec.rows || [])
  useEffect(() => {
    setTmplRows(sec.rows || [])
  }, [sec.rows])

  const fieldIds = useMemo(() => {
    const ids: string[] = sec.fields.map(f => f.field_id)
    if (tmplRows) {
      for (const r of tmplRows) {
        for (let ci = 0; ci < (r.values ?? []).length; ci++) {
          ids.push(`${sec.section_id}__${r.row_id}__col${ci}`)
        }
      }
    }
    return ids
  }, [sec, tmplRows])

  const defaultCount = useMemo(
    () =>
      fieldIds.filter(fid => {
        const ef = extractedMap.get(fid)
        const defVal = ef?.default_value ?? ''
        const val = fieldValues[fid] ?? ef?.value ?? defVal
        const orig = ef?.original_value ?? ef?.value ?? ''
        const { isDefault } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)
        return isDefault
      }).length,
    [fieldIds, fieldValues, extractedMap]
  )

  // Check if section contains any field matching the active filter
  const hasMatchingFilterField = useMemo(() => {
    if (activeFilter === 'all') return true
    for (const fid of fieldIds) {
      const ef = extractedMap.get(fid)
      const defVal = ef?.default_value ?? ''
      const val = fieldValues[fid] ?? ef?.value ?? defVal
      const orig = ef?.original_value ?? ef?.value ?? ''
      const { isDefault, isReview, isVerified } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)
      if (activeFilter === 'default' && isDefault) return true
      if (activeFilter === 'review' && isReview) return true
      if (activeFilter === 'verified' && isVerified) return true
    }
    return false
  }, [fieldIds, activeFilter, fieldValues, extractedMap])

  if (!hasMatchingFilterField) return null

  const matches =
    !searchQuery ||
    title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    num.includes(searchQuery) ||
    sec.fields.some(f => f.field_label.toLowerCase().includes(searchQuery.toLowerCase()))

  if (!matches) return null

  const isTableSection = sec.field_type === 'table' || (sec.columns && sec.columns.length > 0)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden mb-3">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-slate-50/60 transition-colors"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {num ? (
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center shadow-sm">
              {num.split('.')[0]}
            </span>
          ) : (
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-slate-400 text-white text-[11px] font-bold flex items-center justify-center">
              §
            </span>
          )}
          <span className="text-sm font-bold text-slate-900 uppercase tracking-wide truncate">
            {num ? `${num}   ${title}` : title}
          </span>
          {defaultCount > 0 && (
            <span className="flex-shrink-0 px-2 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full text-[10px] font-bold">
              {defaultCount} default
            </span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-slate-400 transition-transform duration-200 ml-3 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 px-5 py-4 bg-slate-50/20 space-y-3">
          {/* Table representation if table section */}
          {isTableSection && sec.columns && sec.columns.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm my-3">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-800 text-white text-[11px] font-bold">
                      {sec.columns.map((col, ci) => (
                        <th key={ci} className="px-3 py-2 text-left border-r border-slate-700 last:border-0 uppercase tracking-wider">
                          {col}
                        </th>
                      ))}
                      <th className="px-2 py-2 text-center w-12 border-l border-slate-700 uppercase tracking-wider text-slate-400 font-semibold">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tmplRows.length === 0 ? (
                      <tr>
                        <td colSpan={sec.columns.length + 1} className="py-5 text-center text-xs text-slate-400 italic">
                          No rows in this table. Click "+ Add Row" to insert a row.
                        </td>
                      </tr>
                    ) : (
                      tmplRows.map((row, ri) => (
                        <tr key={ri} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                          {row.values.map((cell, ci) => {
                            const cellFid = `${sec.section_id}__${row.row_id}__col${ci}`
                            const ef = extractedMap.get(cellFid)
                            const defVal = ef?.default_value ?? cell ?? ''
                            const val = fieldValues[cellFid] ?? ef?.value ?? defVal
                            const isDef = ef?.validation_status === 'default' || (Boolean(defVal) && val === defVal && (!ef || !ef.original_value))
                            return (
                              <td key={ci} className="p-1.5 border-r border-slate-100 last:border-0">
                                <input
                                  type="text"
                                  className={`w-full px-2 py-1.5 text-xs rounded transition-all focus:outline-none focus:ring-1 ${
                                    isDef
                                      ? 'bg-indigo-50/50 text-indigo-900 border border-indigo-300 focus:ring-indigo-500 font-medium'
                                      : 'bg-white text-slate-900 border border-slate-200 hover:border-slate-300 focus:border-blue-500 focus:ring-blue-500'
                                  }`}
                                  value={val}
                                  placeholder={sec.columns?.[ci] ? `Enter ${sec.columns[ci]}...` : ''}
                                  onChange={e => onFieldChange(cellFid, e.target.value)}
                                  onBlur={() => onSave(cellFid)}
                                  title={isDef ? 'Using template default value' : undefined}
                                />
                              </td>
                            )
                          })}
                          <td className="p-1.5 text-center w-12 border-l border-slate-100">
                            <button
                              type="button"
                              onClick={() => setTmplRows(prev => prev.filter((_, idx) => idx !== ri))}
                              title="Delete this row"
                              className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5 mx-auto" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="px-4 py-2 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    const colCount = sec.columns?.length || 4
                    const nextId = `row_${Date.now()}`
                    const isCol0Serial = sec.columns?.[0]?.toLowerCase().includes('no') || sec.columns?.[0]?.toLowerCase().includes('sl')
                    const newVals = Array(colCount).fill('')
                    if (isCol0Serial) newVals[0] = String(tmplRows.length + 1)
                    setTmplRows(prev => [...prev, { row_id: nextId, values: newVals }])
                    if (isCol0Serial) {
                      onFieldChange(`${sec.section_id}__${nextId}__col0`, String(tmplRows.length + 1))
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-600 bg-white hover:bg-blue-50 rounded-lg border border-blue-200 transition-colors shadow-2xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Row</span>
                </button>
                <span className="text-[11px] text-slate-400 font-medium">
                  {tmplRows.length} {tmplRows.length === 1 ? 'row' : 'rows'}
                </span>
              </div>
            </div>
          )}

          {/* Fields list */}
          {sec.fields.length > 0 && (
            <div className="space-y-3">
              {sec.fields.map(field => {
                const ef = extractedMap.get(field.field_id)
                const defVal = ef?.default_value ?? field.default_value ?? ''
                const val = fieldValues[field.field_id] ?? ef?.value ?? defVal
                const orig = ef?.original_value ?? ef?.value ?? ''
                const { isDefault, isReview, isVerified } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)

                if (activeFilter === 'default' && !isDefault) return null
                if (activeFilter === 'review' && !isReview) return null
                if (activeFilter === 'verified' && !isVerified) return null

                return (
                  <FieldInput
                    key={field.field_id}
                    fieldId={field.field_id}
                    label={field.field_label}
                    value={val}
                    origExtracted={orig}
                    confidence={confidencePct(ef)}
                    validationStatus={ef?.validation_status}
                    defaultValue={defVal}
                    sourceRef={ef?.source_references?.[0] ?? null}
                    onChange={v => onFieldChange(field.field_id, v)}
                    onSave={() => onSave(field.field_id)}
                  />
                )
              })}
            </div>
          )}

          {/* Section save button */}
          {fieldIds.length > 0 && (
            <div className="flex justify-end pt-3 border-t border-slate-100">
              <button
                disabled={saving}
                onClick={() => void onSaveSection(fieldIds)}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-xl text-xs font-semibold shadow-sm transition-colors"
              >
                {saving ? 'Saving…' : '✓ Save Section'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export interface JiraFieldEditorProps {
  embedded?: boolean
  jobId?: number | string
  projectId?: number | string
  hideHeader?: boolean
}

export default function JiraFieldEditor(props: JiraFieldEditorProps = {}) {
  const routeParams = useParams<{ projectId: string; jobId: string }>()
  const navigate = useNavigate()

  const projectId = props.projectId ? String(props.projectId) : routeParams.projectId
  const jobId = props.jobId ? String(props.jobId) : routeParams.jobId
  const isEmbedded = Boolean(props.embedded)

  const [job, setJob] = useState<ExtractionJob | null>(null)
  const [template, setTemplate] = useState<SchemaTemplate | null>(null)
  const [validation, setValidation] = useState<StructuralValidationResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [savingSections, setSavingSections] = useState<Record<string, boolean>>({})

  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState<FilterType>('all')
  const [enableStaticEditing, setEnableStaticEditing] = useState(false)

  // ── Load Data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return
    setLoading(true)
    Promise.all([
      fetchJob(jobId),
      structuralCheck(Number(jobId)).catch(() => null),
    ])
      .then(async ([fetchedJob, val]) => {
        setJob(fetchedJob)
        setValidation(val)

        // Seed field values from extracted_fields (DB ground truth)
        const initVals: Record<string, string> = {}
        for (const f of fetchedJob.extracted_fields ?? []) {
          initVals[f.field_id] = f.value ?? f.default_value ?? ''
        }

        // Also seed from populated_tree bindings if present
        if (fetchedJob.populated_tree?.sections) {
          function seedBt(sec: BtSection) {
            for (const b of sec.blocks) {
              if (b.field_binding?.field_id && !(b.field_binding.field_id in initVals)) {
                initVals[b.field_binding.field_id] = b.field_binding.value ?? ''
              }
            }
            sec.subsections.forEach(seedBt)
          }
          fetchedJob.populated_tree.sections.forEach(seedBt)
        }

        const tmpl = await fetchTemplate(
          fetchedJob.template_id,
          fetchedJob.template_code,
          fetchedJob.template_name
        )
        setTemplate(tmpl)

        // Pre-fill missing fields with template default_value if empty
        if (tmpl?.sections) {
          for (const s of tmpl.sections) {
            for (const f of s.fields) {
              if (f.default_value && (!initVals[f.field_id] || initVals[f.field_id].trim() === '')) {
                initVals[f.field_id] = f.default_value
              }
            }
            for (const r of s.rows ?? []) {
              for (let ci = 0; ci < (r.values ?? []).length; ci++) {
                const cellFid = `${s.section_id}__${r.row_id}__col${ci}`
                const dVal = r.values[ci] || '—'
                if (!initVals[cellFid] || initVals[cellFid].trim() === '') {
                  initVals[cellFid] = dVal
                }
              }
            }
          }
        }
        setFieldValues(initVals)

        // Default expand top sections
        const exp = new Set<string>()
        if (fetchedJob.populated_tree?.sections?.length) {
          fetchedJob.populated_tree.sections.forEach(s => exp.add(s.section_id))
        }
        if (tmpl?.sections?.length) {
          tmpl.sections.forEach((s, idx) => exp.add(s.section_id || `sec-${idx}`))
        }
        setExpandedSections(exp)
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [jobId])

  // ── Lookup Maps ───────────────────────────────────────────────────────────
  const extractedMap = useMemo(() => {
    const m = new Map<string, ExtractedField>()
    for (const f of job?.extracted_fields ?? []) m.set(f.field_id, f)
    return m
  }, [job])

  // ── Cover Section (from template schema) ──────────────────────────────────
  const coverSection = useMemo(() => {
    return template?.sections.find(isCoverSection) ?? null
  }, [template])

  // ── Preamble Blocks (from populated_tree) ─────────────────────────────────
  const preambleBlocks = useMemo(() => {
    const pSec = job?.populated_tree?.sections?.find(
      s => s.heading_text === '__preamble__' || s.section_id === 'sec_preamble'
    )
    return pSec?.blocks ?? []
  }, [job])

  // ── Body Sections ─────────────────────────────────────────────────────────
  // 1. Populated tree sections excluding preamble
  const btBodySections = useMemo(() => {
    return (job?.populated_tree?.sections ?? []).filter(
      s => s.heading_text !== '__preamble__' && s.section_id !== 'sec_preamble'
    )
  }, [job])

  // 2. Template schema sections excluding cover
  const tmplBodySections = useMemo(() => {
    return (template?.sections ?? []).filter(s => !isCoverSection(s))
  }, [template])

  // Map template body sections by normalized section number or name
  const tmplSectionMap = useMemo(() => {
    const m = new Map<string, SchemaSection>()
    for (const ts of tmplBodySections) {
      if (ts.section_number) {
        m.set(ts.section_number.trim(), ts)
      }
      m.set(ts.section_name.trim().toLowerCase(), ts)
    }
    return m
  }, [tmplBodySections])

  // Track which template body sections were matched in btBodySections
  const matchedTmplSecIds = useMemo(() => {
    const matched = new Set<string>()
    for (const bSec of btBodySections) {
      const sNum = (bSec.section_number || '').trim()
      const sTitle = (bSec.heading_text || '').trim().toLowerCase()
      const matchedTs = tmplSectionMap.get(sNum) || tmplSectionMap.get(sTitle)
      if (matchedTs?.section_id) {
        matched.add(matchedTs.section_id)
      }
    }
    return matched
  }, [btBodySections, tmplSectionMap])

  // Template body sections not already matched/rendered by btBodySections
  const unmappedTmplSections = useMemo(() => {
    return tmplBodySections.filter(ts => !matchedTmplSecIds.has(ts.section_id))
  }, [tmplBodySections, matchedTmplSecIds])

  // Map template fields by field_id
  const tmplFieldMap = useMemo(() => {
    const m = new Map<string, SchemaField>()
    for (const s of template?.sections ?? []) {
      for (const f of s.fields) {
        m.set(f.field_id, f)
      }
      for (const r of s.rows ?? []) {
        for (let ci = 0; ci < (r.values ?? []).length; ci++) {
          const cellFid = `${s.section_id}__${r.row_id}__col${ci}`
          m.set(cellFid, {
            field_id: cellFid,
            field_label: `${s.columns?.[ci] || `Col ${ci + 1}`} (${r.row_label || r.row_id})`,
            default_value: r.values[ci] || '—',
          } as SchemaField)
        }
      }
    }
    return m
  }, [template])

  // ── Stats calculation ─────────────────────────────────────────────────────
  // Driven by DB extracted_fields (ground truth)
  const stats = useMemo(() => {
    let total = 0
    let defaultCount = 0
    let review = 0
    let verified = 0

    // Count all extracted fields
    const allFieldIds = new Set<string>()
    for (const f of job?.extracted_fields ?? []) {
      allFieldIds.add(f.field_id)
    }
    // Also include template schema fields
    for (const s of template?.sections ?? []) {
      for (const f of s.fields) {
        allFieldIds.add(f.field_id)
      }
      for (const r of s.rows ?? []) {
        for (let ci = 0; ci < (r.values ?? []).length; ci++) {
          allFieldIds.add(`${s.section_id}__${r.row_id}__col${ci}`)
        }
      }
    }

    for (const fid of allFieldIds) {
      total++
      const ef = extractedMap.get(fid)
      const tf = tmplFieldMap.get(fid)
      const defVal = ef?.default_value ?? tf?.default_value ?? ''
      const val = fieldValues[fid] ?? ef?.value ?? defVal
      const orig = ef?.original_value ?? ef?.value ?? ''
      const { isDefault, isReview } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)
      if (isDefault) defaultCount++
      else if (isReview) review++
      else verified++
    }

    return { total, defaultCount, review, verified }
  }, [job, template, fieldValues, extractedMap, tmplFieldMap])

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleFieldChange = (fid: string, v: string) => {
    setFieldValues(prev => ({ ...prev, [fid]: v }))
  }

  const handleSaveField = async (fid: string, valOverride?: string) => {
    if (!jobId) return
    const val = valOverride !== undefined ? valOverride : (fieldValues[fid] ?? '')
    try {
      await patchField(jobId, fid, val)
      // Immediately mark verified in local job state so badges flip instantly!
      setJob(prev => {
        if (!prev) return prev
        const nextFields = (prev.extracted_fields || []).map(f => {
          if (f.field_id === fid) {
            return { ...f, value: val, validation_status: 'verified' }
          }
          return f
        })
        return { ...prev, extracted_fields: nextFields }
      })
    } catch (e) {
      console.error('Field save failed', e)
    }
  }

  const handleSaveSection = async (secId: string, fids: string[]) => {
    if (!jobId) return
    setSavingSections(p => ({ ...p, [secId]: true }))
    try {
      await Promise.all(fids.map(fid => patchField(jobId, fid, fieldValues[fid] ?? '')))
      const updated = await fetchJob(jobId)
      setJob(updated)
    } catch (e) {
      alert(`Save error: ${(e as Error).message}`)
    } finally {
      setSavingSections(p => ({ ...p, [secId]: false }))
    }
  }

  const handleBlockUpdate = useCallback((blockId: string, newText: string) => {
    setJob(prev => {
      if (!prev || !prev.populated_tree) return prev
      const newPtree = JSON.parse(JSON.stringify(prev.populated_tree)) as BtTree
      function updateInSec(sec: BtSection) {
        for (const b of sec.blocks) {
          if (b.block_id === blockId) {
            if (!b.original_text && b.text) {
              b.original_text = b.text
            }
            b.text = newText
            b.is_edited = true
            return
          }
        }
        sec.subsections.forEach(updateInSec)
      }
      newPtree.sections.forEach(updateInSec)
      return { ...prev, populated_tree: newPtree }
    })
  }, [])

  const handleBlockTableUpdate = useCallback((blockId: string, newTableData: string[][]) => {
    setJob(prev => {
      if (!prev || !prev.populated_tree) return prev
      const newPtree = JSON.parse(JSON.stringify(prev.populated_tree)) as BtTree
      function updateInSec(sec: BtSection) {
        for (const b of sec.blocks) {
          if (b.block_id === blockId) {
            b.table_data = newTableData
            b.is_edited = true
            return
          }
        }
        sec.subsections.forEach(updateInSec)
      }
      newPtree.sections.forEach(updateInSec)
      return { ...prev, populated_tree: newPtree }
    })

    if (jobId) {
      patchBlockTable(jobId, blockId, newTableData).catch(err => {
        console.error('Failed to save table data to backend:', err)
      })
    }
  }, [jobId])

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAll = () => {
    const next = new Set<string>()
    btBodySections.forEach(s => next.add(s.section_id))
    tmplBodySections.forEach((s, idx) => next.add(s.section_id || `sec-${idx}`))
    setExpandedSections(next)
  }

  const collapseAll = () => setExpandedSections(new Set())

  // ── Loading & Error states ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className={isEmbedded ? "py-16 bg-white rounded-2xl border border-slate-200 flex items-center justify-center" : "min-h-screen bg-slate-100 flex items-center justify-center"}>
        <div className="text-center space-y-4">
          <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-600 text-sm font-semibold">Loading document editor…</p>
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className={isEmbedded ? "py-12 bg-white rounded-2xl border border-red-200 p-6 flex items-center justify-center" : "min-h-screen bg-slate-100 flex items-center justify-center p-6"}>
        <div className="text-center max-w-md">
          <div className="text-3xl mb-3">⚠️</div>
          <p className="text-red-600 font-semibold mb-4">{error ?? 'Job not found'}</p>
          {!isEmbedded && (
            <button
              onClick={() => navigate(-1)}
              className="px-5 py-2 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-colors"
            >
              ← Go Back
            </button>
          )}
        </div>
      </div>
    )
  }

  const docTitle = template?.template_name ?? job.template_name ?? `Job #${jobId}`
  const hasBtSections = btBodySections.length > 0

  return (
    <div className={isEmbedded ? "w-full font-sans space-y-4" : "min-h-screen bg-[#f1f5f9] font-sans pb-28"}>
      {/* ── Fixed Top Header Bar (standalone mode only) ── */}
      {!isEmbedded && !props.hideHeader && (
        <header className="sticky top-0 z-50 bg-[#0f172a] border-b border-slate-800 shadow-lg px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(`/projects/${projectId}`)}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg border border-slate-700 transition-colors"
            >
              ← Back to Project
            </button>
            <div>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">
                Engineering Specification Editor
              </p>
              <h1 className="text-sm font-bold text-white truncate max-w-md">{docTitle}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {validation?.status && (
              <span
                className={`px-3 py-1 rounded-full text-[11px] font-bold border ${
                  validation.status === 'MATCH'
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                }`}
              >
                {validation.status}
              </span>
            )}
            <button
              onClick={() => void downloadExport(jobId!, 'docx')}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg transition-colors shadow-sm flex items-center gap-1.5"
            >
              ⬇ Download DOCX
            </button>
            <button
              onClick={() => void downloadExport(jobId!, 'pdf')}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition-colors shadow-sm flex items-center gap-1.5"
            >
              ⬇ Download PDF
            </button>
          </div>
        </header>
      )}

      {/* ── Page Content ── */}
      <main className={isEmbedded ? "w-full space-y-4" : "max-w-4xl mx-auto px-4 pt-8 pb-10 space-y-4"}>
        {/* ── 1. Dedicated Cover Page Card (Always prominent at top) ── */}
        <CoverPageCard
          coverSection={coverSection}
          preambleBlocks={preambleBlocks}
          extractedMap={extractedMap}
          fieldValues={fieldValues}
          onFieldChange={handleFieldChange}
          onSave={handleSaveField}
          jobId={jobId!}
        />

        {/* ── 2. Document Controls & Filter Bar ── */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-slate-900">{docTitle}</h2>
            <span className="text-xs font-semibold text-slate-400">
              {stats.total} total parameters
            </span>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <span className="absolute inset-y-0 left-3 flex items-center text-slate-400 pointer-events-none">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 111 11a6 6 0 0116 0z" />
                </svg>
              </span>
              <input
                type="text"
                placeholder="Search sections or fields…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:border-blue-400 bg-slate-50 focus:bg-white transition-colors"
              />
            </div>

            <button
              onClick={expandAll}
              className="px-3 py-2 text-xs font-semibold bg-slate-100 border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-200 transition-colors"
            >
              Expand All
            </button>
            <button
              onClick={collapseAll}
              className="px-3 py-2 text-xs font-semibold bg-slate-100 border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-200 transition-colors"
            >
              Collapse All
            </button>

            {/* Optional Static Field Editing Toggle */}
            <button
              type="button"
              onClick={() => setEnableStaticEditing(p => !p)}
              className={`px-3 py-2 text-xs font-semibold border rounded-xl transition-all flex items-center gap-1.5 ${
                enableStaticEditing
                  ? 'bg-blue-50 text-blue-700 border-blue-300 ring-2 ring-blue-500/20 shadow-2xs'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
              title="Toggle optional static text editing mode across all document sections"
            >
              <Pencil className="w-3.5 h-3.5 text-blue-600" />
              <span>Edit Static Fields</span>
              {enableStaticEditing && (
                <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
              )}
            </button>

            {/* Filter Buttons */}
            {(
              [
                ['all', `All (${stats.total})`, 'bg-blue-600 text-white border-blue-600'],
                ['default', `📋 Default (${stats.defaultCount})`, 'bg-indigo-600 text-white border-indigo-600'],
                ['review', `⚠️ Review (${stats.review})`, 'bg-amber-500 text-white border-amber-500'],
                ['verified', `✓ Verified (${stats.verified})`, 'bg-emerald-600 text-white border-emerald-600'],
              ] as const
            ).map(([f, label, activeClass]) => (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                className={`px-3 py-2 text-xs font-semibold border rounded-xl transition-colors ${
                  activeFilter === f ? activeClass : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ── 3. Hybrid Section List ── */}
        <div className="space-y-3">
          {/* Document block-tree sections */}
          {btBodySections.map(sec => {
            // Try to find matching template schema section by section number or heading text
            const sNum = (sec.section_number || '').trim()
            const sTitle = (sec.heading_text || '').trim().toLowerCase()
            const matchedTemplateSec = tmplSectionMap.get(sNum) || tmplSectionMap.get(sTitle) || null

            return (
              <BtSectionCard
                key={sec.section_id}
                sec={sec}
                level={0}
                jobId={jobId!}
                extractedMap={extractedMap}
                fieldValues={fieldValues}
                activeFilter={activeFilter}
                searchQuery={searchQuery}
                onFieldChange={handleFieldChange}
                onSave={handleSaveField}
                onSaveSection={fieldIds => handleSaveSection(sec.section_id, fieldIds)}
                onBlockUpdate={handleBlockUpdate}
                onBlockTableUpdate={handleBlockTableUpdate}
                enableStaticEditing={enableStaticEditing}
                saving={savingSections[sec.section_id] ?? false}
                expanded={expandedSections.has(sec.section_id)}
                onToggle={() => toggleSection(sec.section_id)}
                matchedTemplateSec={matchedTemplateSec}
              />
            )
          })}

          {/* Template sections not present in source document (tables, standard specs with defaults) */}
          {unmappedTmplSections.map((sec, idx) => {
            const secId = sec.section_id || `sec-${idx}`
            return (
              <TmplSectionCard
                key={secId}
                sec={sec}
                extractedMap={extractedMap}
                fieldValues={fieldValues}
                activeFilter={activeFilter}
                searchQuery={searchQuery}
                onFieldChange={handleFieldChange}
                onSave={handleSaveField}
                onSaveSection={fieldIds => handleSaveSection(secId, fieldIds)}
                saving={savingSections[secId] ?? false}
                expanded={expandedSections.has(secId)}
                onToggle={() => toggleSection(secId)}
              />
            )
          })}

          {btBodySections.length === 0 && unmappedTmplSections.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center text-slate-400 text-sm shadow-sm">
              No sections found in document. Please run extraction.
            </div>
          )}
        </div>
      </main>


    </div>
  )
}
