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
import { Pencil, Check, X, RotateCcw, Plus, Trash2, Filter, ChevronDown, ChevronUp, FileText, ClipboardList, AlertTriangle, CheckCircle2 } from 'lucide-react'

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
  content_page?: { number: string; title: string }[]
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
          content_page: d.content_page || raw.content_page || [],
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
          content_page: found.content_page || raw.content_page || [],
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

export interface ResolvedClause {
  groupKey: string
  groupNum: string
  groupTitle: string
  clauseNum: string
  clauseTitle: string
}

export const CANONICAL_SPEC01_TOC: Record<string, { num: string; title: string }> = {
  '1': { num: '1.0', title: 'SCOPE' },
  '2': { num: '2.0', title: 'GENERAL & DESIGN CONDITIONS' },
  '3': { num: '3.0', title: 'POWER DISTRIBUTION PHILOSOPHY' },
  '4': { num: '4.0', title: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS' },
  '5': { num: '5.0', title: 'LIGHTING SYSTEM' },
  '6': { num: '6.0', title: 'HEAT TRACING SYSTEM' },
  '7': { num: '7.0', title: 'FIRE ALARM SYSTEM' },
  '8': { num: '8.0', title: 'PLANT COMMUNICATION SYSTEM' },
  '9': { num: '9.0', title: 'STATUTORY APPROVAL' },
}

export const CANONICAL_BRANCH_TITLES: Record<string, string> = {
  // Section 1.0
  '1.0': 'SCOPE',
  // Section 2.0
  '2.0': 'GENERAL',
  '2.1': 'STANDARDS AND CODES',
  '2.2': 'SITE CONDITIONS',
  '2.3': 'POWER SUPPLY CONDITIONS',
  '2.4': 'UTILIZATION VOLTAGES',
  '2.5': 'LOAD CLASSIFICATION',
  '2.6': 'HAZARDOUS AREA CLASSIFICATION',
  // Section 3.0
  '3.0': 'DESIGN PHILOSOPHY',
  '3.1': 'POWER DISTRIBUTION PHILOSOPHY',
  '3.2': 'CABLES',
  '3.3': 'ELECTRICAL ROOMS / TRANSFORMER AREA',
  '3.4': 'GROUNDING AND LIGHTNING PROTECTION',
  '3.5': 'START / STOP PHILOSOPHY',
  '3.6': 'CONVENIENCE RECEPTACLES',
  // Section 4.0
  '4.1': '11 KV OUTDOOR LOAD BREAK SWITCH',
  '4.2': 'EMERGENCY (STAND BY) DG SET',
  '4.3': 'DISTRIBUTION TRANSFORMER',
  '4.4': 'LV BUSDUCT',
  '4.5': 'POWER & MOTOR CONTROL CENTER (PMCC / MCC)',
  '4.6': 'MAIN LIGHTING / POWER DISTRIBUTION BOARD',
  '4.7': 'INVERTERS',
  '4.8': 'UN-INTERRUPTED POWER SUPPLY (UPS) SYSTEM',
  '4.9': 'BATTERY & BATTERY CHARGER',
  '4.10': 'MV / LV MOTORS',
  '4.11': 'LOCAL CONTROL STATION',
  '4.12': 'FLAME PROOF / EXPLOSION PROOF EQUIPMENT',
  '4.13': 'PACKAGE UNITS EQUIPMENT',
  // Section 5.0
  '5.0': 'LIGHTING SYSTEM',
  '5.1': 'LIGHTING DESIGN PHILOSOPHY',
  '5.2': 'WIRING TYPE',
  '5.3': 'SUB LIGHTING DISTRIBUTION BOARD',
  // Section 6.0
  '6.0': 'HEAT TRACING SYSTEM',
  // Section 7.0
  '7.0': 'FIRE ALARM SYSTEM',
  '7.1': 'FIRE ALARM PANEL',
  // Section 8.0
  '8.0': 'PLANT COMMUNICATION SYSTEM',
  '8.1': 'PUBLIC ADDRESS SYSTEM',
  '8.2': 'TELEPHONE SYSTEM',
  // Section 9.0
  '9.0': 'STATUTORY APPROVAL',
}

export function getBranchKey(clauseNum: string): string {
  const parts = clauseNum.split('.')
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`
  }
  return clauseNum
}

export function resolveClause(
  secNum?: string | null,
  heading?: string | null,
  contentPage?: { number: string; title: string }[]
): ResolvedClause {
  const text = (heading || '').toUpperCase().trim()
  const rawNum = (secNum || '').trim()
  // Clean clause number from any trailing whitespace/tabs and text (e.g. "4.1.1\t11" -> num="4.1.1", remainder="11")
  const cleanNumMatch = rawNum.match(/^(\d+(?:\.\d+)*)/)
  const num = cleanNumMatch ? cleanNumMatch[0] : rawNum
  const numRemainder = cleanNumMatch && cleanNumMatch[0].length < rawNum.length ? rawNum.slice(cleanNumMatch[0].length).trim() : ''
  const fullHeading = numRemainder ? `${numRemainder} ${(heading || '').trim()}`.trim() : (heading || '').trim()
  const cleanTitle = (fullHeading || '').replace(/^[0-9\.\-\s\t]+/, '').trim().toUpperCase() || text

  // 1.0 SCOPE
  if (num === '1.0' || num === '1' || (text.includes('SCOPE') && (num.startsWith('1.') || !num))) {
    return { groupKey: '1', groupNum: '1.0', groupTitle: 'SCOPE', clauseNum: '1.0', clauseTitle: 'SCOPE' }
  }

  // 9.0 STATUTORY APPROVAL
  if (num.startsWith('9.') || num === '9.0' || num === '9' || text.includes('STATUTORY') || text.includes('STATUATORY')) {
    return { groupKey: '9', groupNum: '9.0', groupTitle: 'STATUTORY APPROVAL', clauseNum: '9.0', clauseTitle: 'STATUTORY APPROVAL' }
  }

  // 8.0 PLANT COMMUNICATION SYSTEM
  if (num === '8.1' || text.includes('PUBLIC ADDRESS')) {
    return { groupKey: '8', groupNum: '8.0', groupTitle: 'PLANT COMMUNICATION SYSTEM', clauseNum: '8.1', clauseTitle: 'PUBLIC ADDRESS SYSTEM' }
  }
  if (num === '8.2' || text.includes('TELEPHONE') || text.includes('IP PHONE')) {
    return { groupKey: '8', groupNum: '8.0', groupTitle: 'PLANT COMMUNICATION SYSTEM', clauseNum: '8.2', clauseTitle: 'TELEPHONE SYSTEM' }
  }
  if (num.startsWith('8.') || text.includes('COMMUNICATION')) {
    return { groupKey: '8', groupNum: '8.0', groupTitle: 'PLANT COMMUNICATION SYSTEM', clauseNum: '8.0', clauseTitle: 'PLANT COMMUNICATION SYSTEM' }
  }

  // 7.0 FIRE ALARM SYSTEM
  if (num === '7.1' || text.includes('FIRE ALARM PANEL')) {
    return { groupKey: '7', groupNum: '7.0', groupTitle: 'FIRE ALARM SYSTEM', clauseNum: '7.1', clauseTitle: 'FIRE ALARM PANEL' }
  }
  if (num.startsWith('7.')) {
    return { groupKey: '7', groupNum: '7.0', groupTitle: 'FIRE ALARM SYSTEM', clauseNum: num, clauseTitle: cleanTitle || 'FIRE ALARM SYSTEM' }
  }
  if (text.includes('FIRE ALARM')) {
    return { groupKey: '7', groupNum: '7.0', groupTitle: 'FIRE ALARM SYSTEM', clauseNum: '7.0', clauseTitle: cleanTitle || 'FIRE ALARM SYSTEM' }
  }

  // 6.0 HEAT TRACING SYSTEM
  if (num.startsWith('6.') || text.includes('HEAT TRACING')) {
    return { groupKey: '6', groupNum: '6.0', groupTitle: 'HEAT TRACING SYSTEM', clauseNum: '6.0', clauseTitle: 'HEAT TRACING SYSTEM' }
  }

  // 5.0 LIGHTING SYSTEM (Clause numbers prioritized)
  if (num.startsWith('5.3.') || num === '5.3') {
    return { groupKey: '5', groupNum: '5.0', groupTitle: 'LIGHTING SYSTEM', clauseNum: num, clauseTitle: cleanTitle || 'SUB LIGHTING DISTRIBUTION BOARD' }
  }
  if (num === '5.2' || text.includes('WIRING TYPE')) {
    return { groupKey: '5', groupNum: '5.0', groupTitle: 'LIGHTING SYSTEM', clauseNum: '5.2', clauseTitle: 'WIRING TYPE' }
  }
  if (num === '5.1.i' || text.includes('ILLUMINATION LEVEL')) {
    return { groupKey: '5', groupNum: '5.0', groupTitle: 'LIGHTING SYSTEM', clauseNum: '5.1.i', clauseTitle: 'ILLUMINATION LEVELS & TYPE OF LAMPS' }
  }
  if (num === '5.1.1' || text.includes('CONTROL PHILOSOPHY')) {
    return { groupKey: '5', groupNum: '5.0', groupTitle: 'LIGHTING SYSTEM', clauseNum: '5.1.1', clauseTitle: 'LIGHTING CONTROL PHILOSOPHY' }
  }
  if (num === '5.1' || text.includes('LIGHTING DESIGN PHILOSOPHY')) {
    return { groupKey: '5', groupNum: '5.0', groupTitle: 'LIGHTING SYSTEM', clauseNum: '5.1', clauseTitle: 'LIGHTING DESIGN PHILOSOPHY' }
  }
  if (text.includes('SUB LIGHTING')) {
    return { groupKey: '5', groupNum: '5.0', groupTitle: 'LIGHTING SYSTEM', clauseNum: '5.3', clauseTitle: cleanTitle || 'SUB LIGHTING DISTRIBUTION BOARD' }
  }
  if (num.startsWith('5.') || (text.includes('LIGHTING') && !['MLDB', 'POWER DISTRIBUTION', 'RECEPTACLE', 'SWITCHBOARD'].some(k => text.includes(k)))) {
    return { groupKey: '5', groupNum: '5.0', groupTitle: 'LIGHTING SYSTEM', clauseNum: '5.0', clauseTitle: 'LIGHTING SYSTEM' }
  }

  // 2.4.5 AUXILIARY SUPPLY (Check before 4.1 switchyard!)
  if (num === '2.4.5' || text.includes('AUXILIARY SUPPLY')) {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.4.5', clauseTitle: 'AUXILIARY SUPPLY FOR SWITCHYARD EQUIPMENTS / MV INDOOR SWITCHBOARD' }
  }

  // 4.0 ELECTRICAL EQUIPMENT (Clause numbers prioritized to prevent loose substring collisions!)
  if (num.startsWith('4.5.') || num === '4.5') {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: num, clauseTitle: cleanTitle || 'PMCC / MCC' }
  }
  if (num.startsWith('4.6.') || num === '4.6') {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: num, clauseTitle: cleanTitle || 'MAIN LIGHTING / POWER DISTRIBUTION BOARD' }
  }
  if (num.startsWith('4.2.') || num === '4.2') {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: num, clauseTitle: cleanTitle || 'EMERGENCY DG SET' }
  }
  if (num.startsWith('4.1.') || num === '4.1' || text.includes('LOAD BREAK SWITCH')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: num.startsWith('4.1') ? num : '4.1.1', clauseTitle: '11 KV OUTDOOR LOAD BREAK SWITCH' }
  }
  if (num === '4.3' || text.includes('DISTRIBUTION TRANSFORMER')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.3', clauseTitle: 'DISTRIBUTION TRANSFORMER' }
  }
  if (num === '4.4' || text.includes('BUSDUCT')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.4', clauseTitle: 'LV BUSDUCT' }
  }
  if (num === '4.7' || text.includes('INVERTER')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.7', clauseTitle: 'INVERTERS' }
  }
  if (num === '4.8' || text.includes('UPS') || text.includes('UN-INTERRUPTED') || text.includes('UNINTERRUPTED')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.8', clauseTitle: 'UN-INTERRUPTED POWER SUPPLY (UPS) SYSTEM' }
  }
  if (num === '4.9' || text.includes('CHARGER') || text.includes('BATTERY')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.9', clauseTitle: 'BATTERY & BATTERY CHARGER' }
  }
  if (num === '4.10' || (text.includes('MOTOR') && !text.includes('STARTER') && !text.includes('MCC') && !text.includes('PMCC') && !num.startsWith('4.5'))) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.10', clauseTitle: 'MV / LV MOTORS' }
  }
  if (num === '4.11' || text.includes('CONTROL STATION')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.11', clauseTitle: 'LOCAL CONTROL STATION' }
  }
  if (num === '4.12' || text.includes('FLAME PROOF') || text.includes('EXPLOSION PROOF')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.12', clauseTitle: 'FLAME PROOF / EXPLOSION PROOF EQUIPMENT' }
  }
  if (num === '4.13' || text.includes('PACKAGE UNIT')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.13', clauseTitle: 'PACKAGE UNITS EQUIPMENT' }
  }
  if (text.includes('POWER &  /') || text.includes('PMCC') || text.includes('MCC')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.5', clauseTitle: 'POWER & MOTOR CONTROL CENTER / MOTOR CONTROL CENTER' }
  }
  if (text.includes('LIGHTING DISTRIBUTION BOARD') || text.includes('POWER DISTRIBUTION BOARD')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.6', clauseTitle: 'MAIN LIGHTING / POWER DISTRIBUTION BOARD' }
  }
  if (text.includes('LOAD BREAK SWITCH')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.1.1', clauseTitle: '11 KV OUTDOOR LOAD BREAK SWITCH' }
  }
  if (text.includes('SWITCHYARD') && !num.startsWith('2.')) {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.1', clauseTitle: '11KV OUTDOOR SWITCHYARD EQUIPMENTS' }
  }
  if (text.includes('ELECTRICAL EQUIPMENT') || num === '4.0' || num === '4') {
    return { groupKey: '4', groupNum: '4.0', groupTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS', clauseNum: '4.0', clauseTitle: 'SPECIFICATION OF ELECTRICAL EQUIPMENTS' }
  }

  // 2.0 GENERAL & DESIGN CONDITIONS
  if (num === '2.0' || (text === 'GENERAL' && !num.startsWith('4.'))) {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.0', clauseTitle: 'GENERAL' }
  }
  if (text.includes('STANDARDS') || text.includes('CODES') || num === '2.1') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.1', clauseTitle: 'STANDARDS AND CODES' }
  }
  if (text.includes('SITE CONDITIONS') || num.startsWith('2.2')) {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: num.startsWith('2.2') ? num : '2.2', clauseTitle: cleanTitle || 'SITE CONDITIONS' }
  }
  if (text.includes('GRID SUPPLY') || num === '2.3.1') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.3.1', clauseTitle: 'GRID SUPPLY' }
  }
  if (text.includes('ALTERNATE POWER') || num === '2.3.2') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.3.2', clauseTitle: 'ALTERNATE POWER SUPPLY' }
  }
  if (text.includes('POWER SUPPLY CONDITIONS') || num === '2.3') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.3', clauseTitle: 'POWER SUPPLY CONDITIONS' }
  }
  if (num.startsWith('2.4')) {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: num, clauseTitle: cleanTitle }
  }
  if (text.includes('UTILIZATION VOLTAGES')) {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.4', clauseTitle: 'UTILIZATION VOLTAGES' }
  }
  if (text.includes('CRITICAL LOAD') && (text.includes('C1') || num === '2.5.1')) {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.5.1', clauseTitle: 'CRITICAL LOAD "C1"' }
  }
  if (text.includes('SEMI-CRITICAL') || text.includes('C2') || num === '2.5.2') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.5.2', clauseTitle: 'SEMI-CRITICAL LOAD "C2"' }
  }
  if (text.includes('NON-CRITICAL') || text.includes('C3') || num === '2.5.3') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.5.3', clauseTitle: 'NON-CRITICAL LOAD "C3"' }
  }
  if (text.includes('LOAD CLASSIFICATION') || num === '2.5') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.5', clauseTitle: 'LOAD CLASSIFICATION' }
  }
  if (text.includes('ZONE 0') || num === '2.6.1') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.6.1', clauseTitle: 'HAZARDOUS AREA ZONE 0' }
  }
  if (text.includes('ZONE 1') || num === '2.6.2') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.6.2', clauseTitle: 'HAZARDOUS AREA ZONE 1' }
  }
  if (text.includes('ZONE 2') || num === '2.6.3') {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.6.3', clauseTitle: 'HAZARDOUS AREA ZONE 2' }
  }
  if (text.includes('HAZARDOUS') || num.startsWith('2.6')) {
    return { groupKey: '2', groupNum: '2.0', groupTitle: 'GENERAL & DESIGN CONDITIONS', clauseNum: '2.6', clauseTitle: 'HAZARDOUS AREA CLASSIFICATION' }
  }

  // 3.0 POWER DISTRIBUTION PHILOSOPHY
  if (text.includes('PRIMARY DISTRIBUTION') || num === '3.1.1') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.1.1', clauseTitle: 'PRIMARY DISTRIBUTION' }
  }
  if (text.includes('SECONDARY DISTRIBUTION') || num === '3.1.2') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.1.2', clauseTitle: 'SECONDARY DISTRIBUTION' }
  }
  if (text.includes('POWER DISTRIBUTION') || num === '3.0' || num === '3.1') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.1', clauseTitle: 'POWER DISTRIBUTION PHILOSOPHY' }
  }
  if (text.includes('VOLTAGE DROP') || num.startsWith('3.2.1')) {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.2.1', clauseTitle: 'VOLTAGE DROPS' }
  }
  if (text.includes('CABLING SYSTEM') || num === '3.2.2') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.2.2', clauseTitle: 'CABLING SYSTEM' }
  }
  if (text.includes('CABLE GLANDING') || num === '3.2.3') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.2.3', clauseTitle: 'CABLE GLANDING & TERMINATION' }
  }
  if (text === 'CABLES' || num === '3.2') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.2', clauseTitle: 'CABLES' }
  }
  if (text.includes('ENVIRONMENTAL CONDITIONS') || num === '3.3.1') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.3.1', clauseTitle: 'ELECTRICAL ROOMS - ENVIRONMENTAL CONDITIONS' }
  }
  if (text.includes('TRANSFORMER AREA') || num === '3.3.2') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.3.2', clauseTitle: 'TRANSFORMER AREA - GENERAL REQUIREMENTS' }
  }
  if (text.includes('ELECTRICAL ROOM') || num === '3.3') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.3', clauseTitle: 'ELECTRICAL ROOMS / TRANSFORMER AREA' }
  }
  if (text.includes('GROUNDING') || text.includes('LIGHTNING') || num === '3.4') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.4', clauseTitle: 'GROUNDING AND LIGHTNING PROTECTION' }
  }
  if ((text.includes('START') && text.includes('STOP')) || num === '3.5') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.5', clauseTitle: 'START / STOP PHILOSOPHY' }
  }
  if (text.includes('RECEPTACLE') || num === '3.6') {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.6', clauseTitle: 'CONVENIENCE RECEPTACLES' }
  }
  if (text.includes('DESIGN PHILOSOPHY')) {
    return { groupKey: '3', groupNum: '3.0', groupTitle: 'POWER DISTRIBUTION PHILOSOPHY', clauseNum: '3.0', clauseTitle: 'DESIGN PHILOSOPHY' }
  }

  // Dynamic Content Page matching (for spec 02, spec 03, or custom templates)
  const numMatch = (num || text).match(/^(\d+)(?:\.(\d+))?/)
  if (numMatch) {
    const top = numMatch[1]
    const sub = numMatch[2]
    const clauseNum = num || (sub ? `${top}.${sub}` : `${top}.0`)

    // Check if contentPage has a matching item
    const cpItem = contentPage?.find(cp => cp.number.split('.')[0] === top)
    if (cpItem) {
      return {
        groupKey: top,
        groupNum: cpItem.number,
        groupTitle: cpItem.title.toUpperCase(),
        clauseNum,
        clauseTitle: cleanTitle || cpItem.title.toUpperCase()
      }
    }

    const canon = CANONICAL_SPEC01_TOC[top]
    if (canon) {
      return {
        groupKey: top,
        groupNum: canon.num,
        groupTitle: canon.title,
        clauseNum,
        clauseTitle: cleanTitle
      }
    }

    return {
      groupKey: top,
      groupNum: `${top}.0`,
      groupTitle: cleanTitle,
      clauseNum,
      clauseTitle: cleanTitle
    }
  }

  return {
    groupKey: 'other',
    groupNum: '—',
    groupTitle: 'ADDITIONAL SECTIONS',
    clauseNum: num || '—',
    clauseTitle: cleanTitle
  }
}

export function parseClauseParts(numStr: string): (number | string)[] {
  return numStr.split(/[\.\s]+/).map(p => {
    const n = parseInt(p, 10)
    return isNaN(n) ? p : n
  })
}

export function compareClauses(a: string, b: string): number {
  const pa = parseClauseParts(a)
  const pb = parseClauseParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i]
    const vb = pb[i]
    if (va === undefined) return -1
    if (vb === undefined) return 1
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va !== vb) return va - vb
    } else {
      const cmp = String(va).localeCompare(String(vb))
      if (cmp !== 0) return cmp
    }
  }
  return 0
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
      className={`rounded-lg border transition-all duration-150 px-3 py-1.5 ${
        isMissing
          ? 'bg-red-50/50 border-red-200'
          : isDefault
          ? 'bg-indigo-50/20 border-indigo-200/90 hover:border-indigo-300'
          : isReview
          ? 'bg-amber-50/40 border-amber-200'
          : 'bg-white border-slate-200/90 hover:border-slate-300'
      }`}
    >
      <div className="flex items-center gap-2.5">
        {/* 1. Field Label (Left, compact & snug) */}
        <label
          title={label}
          className="w-44 md:w-52 flex-shrink-0 text-xs font-bold text-slate-800 uppercase tracking-wide truncate"
        >
          {label}
        </label>

        {/* 2. Value Input (Center, flexible) */}
        <div className="flex-1 min-w-0">
          <textarea
            className={`w-full rounded-md border px-2.5 py-1 text-xs text-slate-900 focus:outline-none focus:ring-2 resize-y transition-colors min-h-[28px] ${
              isMissing
                ? 'border-red-300 bg-white focus:border-red-500 focus:ring-red-100'
                : isDefault
                ? 'border-indigo-200 bg-indigo-50/15 focus:border-indigo-400 focus:ring-indigo-100 focus:bg-white'
                : 'border-slate-200 bg-slate-50 focus:border-blue-400 focus:ring-blue-100 focus:bg-white'
            }`}
            rows={value.length > 80 ? 2 : 1}
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
        </div>

        {/* 3. Status Badges & Source (Far Right, exactly where user arrow points) */}
        <div className="flex-shrink-0 flex items-center gap-1.5">
          {isDefault && (
            <span
              className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full text-[9px] font-bold"
              title="Not found in document — pre-filled with template default value"
            >
              DEFAULT
            </span>
          )}
          {isMissing && (
            <span
              className="px-1.5 py-0.5 bg-red-100 text-red-700 border border-red-200 rounded-full text-[9px] font-bold"
            >
              MISSING
            </span>
          )}
          {isReview && (
            <span
              className="px-1.5 py-0.5 bg-amber-100 text-amber-700 border border-amber-200 rounded-full text-[9px] font-semibold"
            >
              REVIEW
            </span>
          )}
          {isVerified && (
            <span
              className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-full text-[9px] font-semibold"
            >
              ✓ VERIFIED
            </span>
          )}
          {confidence != null && (
            <span
              className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold border ${
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
          {(sourceRef?.page_number || sourceRef?.source_text) && (
            <div className="relative group/src inline-block">
              <span
                className="cursor-pointer px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border bg-blue-50 text-blue-700 border-blue-200 group-hover/src:bg-blue-600 group-hover/src:text-white group-hover/src:border-blue-600 transition-all shadow-2xs inline-flex items-center gap-1"
                title={sourceRef?.source_text ? `Source (p.${sourceRef.page_number ?? '?'}): "${sourceRef.source_text}"` : `Page ${sourceRef?.page_number ?? '?'}`}
              >
                <span>p.{sourceRef?.page_number ?? 1}</span>
              </span>
              {sourceRef?.source_text && (
                <div className="pointer-events-none absolute bottom-full right-0 mb-2.5 hidden group-hover/src:block z-50 w-80 sm:w-96 max-w-sm rounded-xl shadow-2xl shadow-blue-900/15 border border-blue-200/90 bg-white overflow-visible transition-all">
                  {/* Subtle pointing arrow */}
                  <div className="absolute -bottom-1.5 right-4 w-3 h-3 bg-white border-b border-r border-blue-200/90 rotate-45" />

                  {/* Header in project brand blue accent */}
                  <div className="bg-gradient-to-r from-blue-50 to-indigo-50/60 px-3.5 py-2 border-b border-blue-100 flex items-center justify-between rounded-t-xl">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-blue-600"></span>
                      <span className="text-[10px] font-bold text-blue-950 uppercase tracking-wider">
                        Document Source Excerpt
                      </span>
                    </div>
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-white text-blue-700 border border-blue-200 shadow-2xs">
                      Page {sourceRef.page_number ?? '?'}
                    </span>
                  </div>

                  {/* Body with soft quote and highlight border */}
                  <div className="p-3 bg-white rounded-b-xl">
                    <div className="border-l-2 border-blue-500 bg-blue-50/30 rounded-r-lg pl-3 pr-2.5 py-2 text-slate-800 text-xs font-medium leading-relaxed font-sans max-h-48 overflow-y-auto">
                      “{sourceRef.source_text}”
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
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

// ─── Grouped Static Text Editor Component ─────────────────────────────────────

export interface StaticTextGroupEditorProps {
  blocks: BtBlock[]
  jobId: string
  onBlockUpdate?: (blockId: string, newText: string) => void
}

export function StaticTextGroupEditor({
  blocks,
  jobId,
  onBlockUpdate,
}: StaticTextGroupEditorProps) {
  // Combine all paragraphs separated by blank lines
  const initialText = useMemo(() => {
    return blocks
      .map(b => (b.text || '').trim())
      .filter(Boolean)
      .join('\n\n')
  }, [blocks])

  const [draftText, setDraftText] = useState(initialText)
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const isCancelingRef = React.useRef(false)

  useEffect(() => {
    if (!isDirty) {
      setDraftText(initialText)
    }
  }, [initialText, isDirty])

  const handleSave = async () => {
    if (saving) return
    const trimmed = draftText.trim()
    if (!trimmed) return
    if (draftText === initialText) {
      setIsDirty(false)
      return
    }

    setSaving(true)
    try {
      if (blocks.length > 0) {
        // Save full combined text to the first block
        const primaryBlock = blocks[0]
        await patchBlockText(jobId, primaryBlock.block_id, draftText)
        onBlockUpdate?.(primaryBlock.block_id, draftText)

        // Clear any subsequent blocks in this group so they don't duplicate
        for (let i = 1; i < blocks.length; i++) {
          const b = blocks[i]
          if (b.text && b.text.trim()) {
            await patchBlockText(jobId, b.block_id, '')
            onBlockUpdate?.(b.block_id, '')
          }
        }
      }

      setIsDirty(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2500)
    } catch (err) {
      console.error('Failed to save static text:', err)
      alert(`Failed to save text: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    isCancelingRef.current = true
    setDraftText(initialText)
    setIsDirty(false)
    setTimeout(() => {
      isCancelingRef.current = false
    }, 150)
  }

  const handleBlur = () => {
    if (isCancelingRef.current) return
    if (isDirty && draftText.trim() && draftText !== initialText) {
      handleSave()
    }
  }

  const lineCount = draftText.split('\n').length
  const dynamicRows = Math.max(2, Math.min(8, lineCount))

  return (
    <div className="rounded-lg border border-slate-200/90 bg-white p-2.5 shadow-2xs transition-all hover:border-slate-300">
      <textarea
        value={draftText}
        onChange={e => {
          setDraftText(e.target.value)
          setIsDirty(true)
        }}
        onBlur={handleBlur}
        rows={dynamicRows}
        className="w-full p-2 text-xs md:text-sm font-sans text-slate-800 bg-slate-50/40 hover:bg-white focus:bg-white border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-md leading-relaxed resize-y transition-colors outline-none"
        placeholder="Enter paragraph text..."
      />

      {/* Footer controls: tick and wrong icon below, auto-save status */}
      <div className="flex items-center justify-between mt-1.5 pt-1 border-t border-slate-100">
        <div className="flex items-center gap-2">
          {saveSuccess && (
            <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
              <Check className="w-3 h-3" /> Saved
            </span>
          )}
          {saving && (
            <span className="text-[10px] text-slate-500 flex items-center gap-1.5 font-medium">
              <span className="w-2.5 h-2.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              Saving...
            </span>
          )}
          {isDirty && !saving && !saveSuccess && (
            <span className="text-[10px] text-slate-400 italic">
              Unsaved — click outside or (✓) to save
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 ml-auto">
          {/* Wrong / Cancel icon */}
          <button
            type="button"
            onMouseDown={e => {
              e.preventDefault()
              handleCancel()
            }}
            disabled={!isDirty || saving}
            className="p-1 rounded-md border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 hover:border-red-200 disabled:opacity-30 disabled:pointer-events-none transition-colors shadow-2xs"
            title="Cancel / Revert changes (Wrong icon)"
          >
            <X className="w-3.5 h-3.5" />
          </button>

          {/* Tick / Save icon */}
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="p-1 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400 disabled:opacity-30 disabled:pointer-events-none transition-colors shadow-2xs"
            title="Save text (Tick icon)"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

export type GroupedBlockItem =
  | { type: 'field'; block: BtBlock }
  | { type: 'table'; block: BtBlock }
  | { type: 'static_group'; blocks: BtBlock[] }

export function groupBlocks(blocks: BtBlock[]): GroupedBlockItem[] {
  const items: GroupedBlockItem[] = []
  let currentStatic: BtBlock[] = []

  function flushStatic() {
    if (currentStatic.length > 0) {
      items.push({ type: 'static_group', blocks: [...currentStatic] })
      currentStatic = []
    }
  }

  for (const b of blocks) {
    if (b.field_binding?.field_id) {
      flushStatic()
      items.push({ type: 'field', block: b })
    } else if (b.block_type === 'table' && b.table_data && b.table_data.length > 0) {
      flushStatic()
      items.push({ type: 'table', block: b })
    } else if (b.text && b.text.trim()) {
      currentStatic.push(b)
    }
  }
  flushStatic()
  return items
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

  // 3. Regular document text paragraph (with unified editor, tick & wrong icons, auto-save on blur)
  if (text && text.trim()) {
    if (activeFilter !== 'all') return null
    return (
      <StaticTextGroupEditor
        blocks={[block]}
        jobId={jobId}
        onBlockUpdate={onBlockUpdate}
      />
    )
  }

  return null
}

// ─── SubsectionCard & TopLevelGroupAccordion (Reference Images 3 & 4) ────────

export interface GroupSectionItem {
  id: string
  clauseNum: string
  clauseTitle: string
  source: 'doc' | 'tmpl'
  btSec?: BtSection
  tmplSec?: SchemaSection
  matchedTemplateSec?: SchemaSection | null
  fieldIds: string[]
  defaultCount: number
}

export interface SectionBranch {
  branchKey: string
  branchNum: string
  branchTitle: string
  items: GroupSectionItem[]
  isBranchContainer: boolean
  totalSections: number
  defaultCount: number
  hasMatchingFilter: boolean
}

export interface SectionGroup {
  groupKey: string
  groupIndex: number
  groupNum: string
  groupTitle: string
  branches: SectionBranch[]
  sections: GroupSectionItem[]
  totalSections: number
  defaultCount: number
  hasMatchingFilter: boolean
}

interface SubsectionCardProps {
  secItem: GroupSectionItem
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
}

function SubsectionCard({
  secItem,
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
}: SubsectionCardProps) {
  const { clauseNum, clauseTitle, btSec, tmplSec, matchedTemplateSec, fieldIds, defaultCount } = secItem

  // State for template table rows if tmplSec has rows
  const [tmplRows, setTmplRows] = useState(tmplSec?.rows || matchedTemplateSec?.rows || [])
  useEffect(() => {
    setTmplRows(tmplSec?.rows || matchedTemplateSec?.rows || [])
  }, [tmplSec?.rows, matchedTemplateSec?.rows])

  // Check matching filter
  const hasMatchingFilter = useMemo(() => {
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

  if (!hasMatchingFilter) return null

  // Search check
  const matchesSearch =
    !searchQuery ||
    clauseTitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
    clauseNum.includes(searchQuery) ||
    fieldIds.some(fid => {
      const ef = extractedMap.get(fid)
      return (
        fid.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (ef?.field_label || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (fieldValues[fid] || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    })

  if (!matchesSearch) return null

  const activeTmpl = tmplSec || matchedTemplateSec
  const isTableSection = activeTmpl?.field_type === 'table' || (activeTmpl?.columns && activeTmpl.columns.length > 0)
  const hasBlocks = Boolean(btSec && btSec.blocks && btSec.blocks.length > 0)

  return (
    <div className="bg-white rounded-xl border border-slate-200/90 shadow-xs overflow-hidden transition-all">
      {/* Header button matching Image 4 */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-slate-50/70 transition-colors"
      >
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          {/* Light-blue numerical badge */}
          <span className="flex-shrink-0 px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-xs font-bold font-mono tracking-tight shadow-2xs">
            {clauseNum}
          </span>

          {/* Clean uppercase title */}
          <span className="font-bold text-slate-900 uppercase tracking-wide text-xs md:text-sm truncate">
            {clauseTitle}
          </span>

        </div>

        <svg
          className={`w-4 h-4 text-slate-400 transition-transform duration-200 ml-3 flex-shrink-0 ${
            expanded ? 'rotate-180' : ''
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded Card Body */}
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/20 space-y-2">
          {/* 1. Document blocks if present */}
          {hasBlocks && btSec &&
            groupBlocks(btSec.blocks).map((item, idx) => {
              if (item.type === 'static_group') {
                if (activeFilter !== 'all') return null
                return (
                  <StaticTextGroupEditor
                    key={`static_${item.blocks[0]?.block_id || idx}`}
                    blocks={item.blocks}
                    jobId={jobId}
                    onBlockUpdate={onBlockUpdate}
                  />
                )
              }
              if (item.type === 'table') {
                return (
                  <EditableTableBlock
                    key={item.block.block_id}
                    block={item.block}
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
              if (item.type === 'field') {
                return (
                  <BlockRenderer
                    key={item.block.block_id}
                    block={item.block}
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
                )
              }
              return null
            })}

          {/* 2. Fallback for 2.0 GENERAL if 0 blocks */}
          {!hasBlocks && clauseNum === '2.0' && (
            <div className="py-1 px-1.5 flex items-start justify-between gap-3 bg-slate-50/50 rounded-lg">
              <p className="text-xs text-slate-700 leading-relaxed font-sans select-text">
                All electrical equipment shall be designed for continuous operation at rated output under the specified site conditions.
              </p>
            </div>
          )}

          {/* 3. Pure template table section OR document section with 0 blocks matching template table */}
          {(!hasBlocks || !btSec?.blocks.some(b => b.block_type === 'table')) && isTableSection && activeTmpl?.columns && (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm my-3">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-800 text-white text-[11px] font-bold">
                      {activeTmpl.columns.map((col, ci) => (
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
                        <td colSpan={activeTmpl.columns.length + 1} className="py-5 text-center text-xs text-slate-400 italic">
                          No rows in this table. Click "+ Add Row" to insert a row.
                        </td>
                      </tr>
                    ) : (
                      tmplRows.map((row, ri) => (
                        <tr key={ri} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                          {row.values.map((cell, ci) => {
                            const cellFid = `${activeTmpl.section_id}__${row.row_id}__col${ci}`
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
                                  placeholder={activeTmpl.columns?.[ci] ? `Enter ${activeTmpl.columns[ci]}...` : ''}
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
                    const colCount = activeTmpl.columns?.length || 4
                    const nextId = `row_${Date.now()}`
                    const isCol0Serial = activeTmpl.columns?.[0]?.toLowerCase().includes('no') || activeTmpl.columns?.[0]?.toLowerCase().includes('sl')
                    const newVals = Array(colCount).fill('')
                    if (isCol0Serial) newVals[0] = String(tmplRows.length + 1)
                    setTmplRows(prev => [...prev, { row_id: nextId, values: newVals }])
                    if (isCol0Serial) {
                      onFieldChange(`${activeTmpl.section_id}__${nextId}__col0`, String(tmplRows.length + 1))
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

          {/* 4. Template fields if 0 blocks or if matched template has non-table fields */}
          {(!hasBlocks || !btSec?.blocks.some(b => b.field_binding?.field_id)) && activeTmpl?.fields && activeTmpl.fields.length > 0 && (
            <div className="space-y-2">
              {activeTmpl.fields.map(field => {
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

          {/* 5. Section Save button */}
          {fieldIds.length > 0 && (
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
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

// ─── BranchCard Component (Renders a branch container with sub-branches inside) ──

interface BranchCardProps {
  branch: SectionBranch
  expanded: boolean
  onToggle: () => void
  expandedCards: Set<string>
  onToggleCard: (cardId: string) => void
  jobId: string
  extractedMap: Map<string, ExtractedField>
  fieldValues: Record<string, string>
  activeFilter: FilterType
  searchQuery: string
  onFieldChange: (fid: string, v: string) => void
  onSave: (fid: string) => void
  onSaveSection: (secId: string, fieldIds: string[]) => Promise<void>
  onBlockUpdate?: (blockId: string, newText: string) => void
  onBlockTableUpdate?: (blockId: string, newTableData: string[][]) => void
  enableStaticEditing?: boolean
  savingSections: Record<string, boolean>
}

function BranchCard({
  branch,
  expanded,
  onToggle,
  expandedCards,
  onToggleCard,
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
  savingSections,
}: BranchCardProps) {
  if (!branch.hasMatchingFilter) return null

  // Check search query against branch
  const matchesSearch =
    !searchQuery ||
    branch.branchTitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
    branch.branchNum.includes(searchQuery) ||
    branch.items.some(s =>
      s.clauseTitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.clauseNum.includes(searchQuery) ||
      s.fieldIds.some(fid => {
        const ef = extractedMap.get(fid)
        return (
          fid.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (ef?.field_label || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (fieldValues[fid] || '').toLowerCase().includes(searchQuery.toLowerCase())
        )
      })
    )

  if (!matchesSearch) return null

  // If this branch is NOT a container (i.e. single item that matches the branch itself, like 4.3 DISTRIBUTION TRANSFORMER)
  if (!branch.isBranchContainer && branch.items.length === 1) {
    const secItem = branch.items[0]
    return (
      <SubsectionCard
        key={secItem.id}
        secItem={secItem}
        jobId={jobId}
        extractedMap={extractedMap}
        fieldValues={fieldValues}
        activeFilter={activeFilter}
        searchQuery={searchQuery}
        onFieldChange={onFieldChange}
        onSave={onSave}
        onSaveSection={fids => onSaveSection(secItem.id, fids)}
        onBlockUpdate={onBlockUpdate}
        onBlockTableUpdate={onBlockTableUpdate}
        enableStaticEditing={enableStaticEditing}
        saving={savingSections[secItem.id] ?? false}
        expanded={expandedCards.has(secItem.id)}
        onToggle={() => onToggleCard(secItem.id)}
      />
    )
  }

  // Otherwise, render a Branch Card container with its sub-branches inside!
  return (
    <div className="rounded-xl border border-slate-300/80 bg-white shadow-xs overflow-hidden transition-all mb-2.5">
      {/* Branch Header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-slate-50 to-blue-50/30 hover:from-slate-100 hover:to-blue-50/60 transition-colors text-left border-b border-slate-200/60"
      >
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          {/* Light-blue numerical badge matching SubsectionCard */}
          <span className="flex-shrink-0 px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-xs font-bold font-mono tracking-tight shadow-2xs">
            {branch.branchNum}
          </span>

          {/* Clean uppercase title */}
          <span className="font-bold text-slate-900 uppercase tracking-wide text-xs md:text-sm truncate">
            {branch.branchTitle}
          </span>

        </div>

        {/* Chevron icon */}
        <svg
          className={`w-4 h-4 text-slate-500 transition-transform duration-200 ml-3 flex-shrink-0 ${
            expanded ? 'rotate-180' : ''
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Branch Content: Sub-branches inside! */}
      {expanded && (
        <div className="p-2.5 bg-slate-50/50 space-y-2 ml-1.5 border-l-2 border-blue-400/60 pl-3 my-1.5">
          {branch.items.map(secItem => (
            <SubsectionCard
              key={secItem.id}
              secItem={secItem}
              jobId={jobId}
              extractedMap={extractedMap}
              fieldValues={fieldValues}
              activeFilter={activeFilter}
              searchQuery={searchQuery}
              onFieldChange={onFieldChange}
              onSave={onSave}
              onSaveSection={fids => onSaveSection(secItem.id, fids)}
              onBlockUpdate={onBlockUpdate}
              onBlockTableUpdate={onBlockTableUpdate}
              enableStaticEditing={enableStaticEditing}
              saving={savingSections[secItem.id] ?? false}
              expanded={expandedCards.has(secItem.id)}
              onToggle={() => onToggleCard(secItem.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface TopLevelGroupAccordionProps {
  grp: SectionGroup
  expanded: boolean
  onToggle: () => void
  expandedBranches: Set<string>
  onToggleBranch: (branchKey: string) => void
  expandedCards: Set<string>
  onToggleCard: (cardId: string) => void
  jobId: string
  extractedMap: Map<string, ExtractedField>
  fieldValues: Record<string, string>
  activeFilter: FilterType
  searchQuery: string
  onFieldChange: (fid: string, v: string) => void
  onSave: (fid: string) => void
  onSaveSection: (secId: string, fieldIds: string[]) => Promise<void>
  onBlockUpdate?: (blockId: string, newText: string) => void
  onBlockTableUpdate?: (blockId: string, newTableData: string[][]) => void
  enableStaticEditing?: boolean
  savingSections: Record<string, boolean>
}

function TopLevelGroupAccordion({
  grp,
  expanded,
  onToggle,
  expandedBranches,
  onToggleBranch,
  expandedCards,
  onToggleCard,
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
  savingSections,
}: TopLevelGroupAccordionProps) {
  if (!grp.hasMatchingFilter) return null

  // Check search query against group
  const matchesSearch =
    !searchQuery ||
    grp.groupTitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
    grp.groupNum.includes(searchQuery) ||
    grp.sections.some(s =>
      s.clauseTitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.clauseNum.includes(searchQuery) ||
      s.fieldIds.some(fid => {
        const ef = extractedMap.get(fid)
        return (
          fid.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (ef?.field_label || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (fieldValues[fid] || '').toLowerCase().includes(searchQuery.toLowerCase())
        )
      })
    )

  if (!matchesSearch) return null

  return (
    <div className="rounded-2xl border border-blue-900/30 overflow-hidden shadow-sm transition-all mb-4">
      {/* Top Header Button matching Image 3 */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left bg-[#1351a3] hover:bg-[#104791] transition-colors"
      >
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          {/* Index badge [ 1 ], [ 2 ], etc. */}
          <span className="flex-shrink-0 w-7 h-7 rounded-md bg-[#0d3870] text-white text-xs font-bold flex items-center justify-center shadow-inner border border-blue-400/20">
            {grp.groupIndex}
          </span>

          {/* Title: 1.0 SCOPE */}
          <div className="flex items-center gap-2 truncate">
            <span className="text-blue-200 font-semibold text-xs tracking-wider uppercase flex-shrink-0">
              {grp.groupNum}
            </span>
            <span className="text-white font-bold text-sm tracking-wide uppercase truncate">
              {grp.groupTitle}
            </span>
          </div>

        </div>

        {/* Chevron icon */}
        <svg
          className={`w-4 h-4 text-white/80 transition-transform duration-200 ml-3 flex-shrink-0 ${
            expanded ? 'rotate-180' : ''
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Group Content: Render branches with sub-branches inside */}
      {expanded && (
        <div className="p-3 bg-slate-100/70 border-t border-blue-900/20 space-y-2">
          {grp.branches.map(branch => (
            <BranchCard
              key={branch.branchKey}
              branch={branch}
              expanded={expandedBranches.has(branch.branchKey)}
              onToggle={() => onToggleBranch(branch.branchKey)}
              expandedCards={expandedCards}
              onToggleCard={onToggleCard}
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
              savingSections={savingSections}
            />
          ))}
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

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(() => new Set())
  const [groupsInitialized, setGroupsInitialized] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<string>>(() => new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState<FilterType>('all')
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false)
  const filterRef = React.useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterDropdownOpen(false)
      }
    }
    if (filterDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [filterDropdownOpen])

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
        const sNum = ts.section_number.trim()
        m.set(sNum, ts)
        const sNumMatch = sNum.match(/^(\d+(?:\.\d+)*)/)
        if (sNumMatch) m.set(sNumMatch[0], ts)
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
      const sNumClean = sNum.match(/^(\d+(?:\.\d+)*)/)?.[0] || sNum
      const sTitle = (bSec.heading_text || '').trim().toLowerCase()
      const matchedTs = tmplSectionMap.get(sNum) || tmplSectionMap.get(sNumClean) || tmplSectionMap.get(sTitle)
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

  // ── Unified Grouping Logic (TOC-aligned, 0 missed numbers) ────────────────
  const unifiedSectionGroups = useMemo<SectionGroup[]>(() => {
    // 1. Determine canonical TOC list for template
    const tocList: { key: string; num: string; title: string }[] = []
    if (template?.content_page && template.content_page.length > 0) {
      template.content_page.forEach((cp, idx) => {
        const key = cp.number.split('.')[0] || String(idx + 1)
        tocList.push({ key, num: cp.number, title: cp.title.toUpperCase() })
      })
    } else {
      // Fallback to canonical TOC groups
      Object.entries(CANONICAL_SPEC01_TOC).forEach(([k, v]) => {
        tocList.push({ key: k, num: v.num, title: v.title })
      })
    }

    const groupMap = new Map<string, GroupSectionItem[]>()
    tocList.forEach(t => groupMap.set(t.key, []))

    // 2. Flatten populated_tree body sections recursively
    function flattenTree(sections: BtSection[]): BtSection[] {
      const result: BtSection[] = []
      function traverse(s: BtSection) {
        if (s.heading_text === '__preamble__' || s.section_id === 'sec_preamble') return
        // Include if it has blocks, or if it is a leaf section (no subsections)
        if (s.blocks.length > 0 || s.subsections.length === 0) {
          result.push(s)
        }
        s.subsections.forEach(traverse)
      }
      sections.forEach(traverse)
      return result
    }

    const flatBtSections = flattenTree(job?.populated_tree?.sections ?? [])

    // Process document sections
    for (const bSec of flatBtSections) {
      const res = resolveClause(bSec.section_number, bSec.heading_text, template?.content_page)
      const gKey = res.groupKey
      if (!groupMap.has(gKey)) {
        groupMap.set(gKey, [])
      }

      // Collect all field IDs
      const fids: string[] = []
      for (const b of bSec.blocks) {
        if (b.field_binding?.field_id) fids.push(b.field_binding.field_id)
        if (b.row_bindings) {
          for (const rb of Object.values(b.row_bindings)) {
            if (rb.field_id) fids.push(rb.field_id)
          }
        }
        if (b.cell_bindings) {
          for (const cb of Object.values(b.cell_bindings)) {
            if (cb.field_id) fids.push(cb.field_id)
          }
        }
      }

      // Match with template section if available
      const sNum = (bSec.section_number || '').trim()
      const sNumClean = sNum.match(/^(\d+(?:\.\d+)*)/)?.[0] || sNum
      const sTitle = (bSec.heading_text || '').trim().toLowerCase()
      const matchedTs = tmplSectionMap.get(sNum) || tmplSectionMap.get(sNumClean) || tmplSectionMap.get(sTitle) || null
      if (matchedTs?.fields) {
        for (const f of matchedTs.fields) fids.push(f.field_id)
      }
      if (matchedTs?.rows) {
        for (const r of matchedTs.rows) {
          for (let ci = 0; ci < (r.values ?? []).length; ci++) {
            fids.push(`${matchedTs.section_id}__${r.row_id}__col${ci}`)
          }
        }
      }

      const uniqueFids = Array.from(new Set(fids))
      const defCount = uniqueFids.filter(fid => {
        const ef = extractedMap.get(fid)
        const defVal = ef?.default_value ?? ''
        const val = fieldValues[fid] ?? ef?.value ?? defVal
        const orig = ef?.original_value ?? ef?.value ?? ''
        return fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal).isDefault
      }).length

      const existingList = groupMap.get(gKey)!
      const existingIdx = existingList.findIndex(it => it.clauseNum === res.clauseNum)
      if (existingIdx >= 0) {
        // If current has blocks and previous didn't, replace with current
        if (bSec.blocks.length > 0 && (!existingList[existingIdx].btSec || existingList[existingIdx].btSec!.blocks.length === 0)) {
          existingList[existingIdx] = {
            id: bSec.section_id,
            clauseNum: res.clauseNum,
            clauseTitle: res.clauseTitle,
            source: 'doc',
            btSec: bSec,
            matchedTemplateSec: matchedTs,
            fieldIds: uniqueFids,
            defaultCount: defCount,
          }
        }
      } else {
        existingList.push({
          id: bSec.section_id,
          clauseNum: res.clauseNum,
          clauseTitle: res.clauseTitle,
          source: 'doc',
          btSec: bSec,
          matchedTemplateSec: matchedTs,
          fieldIds: uniqueFids,
          defaultCount: defCount,
        })
      }
    }

    // Process unmapped template schema sections
    for (const tSec of unmappedTmplSections) {
      const res = resolveClause(tSec.section_number, tSec.section_name, template?.content_page)
      const gKey = res.groupKey
      if (!groupMap.has(gKey)) {
        groupMap.set(gKey, [])
      }

      const fids: string[] = tSec.fields.map(f => f.field_id)
      if (tSec.rows) {
        for (const r of tSec.rows) {
          for (let ci = 0; ci < (r.values ?? []).length; ci++) {
            fids.push(`${tSec.section_id}__${r.row_id}__col${ci}`)
          }
        }
      }

      const uniqueFids = Array.from(new Set(fids))
      const defCount = uniqueFids.filter(fid => {
        const ef = extractedMap.get(fid)
        const defVal = ef?.default_value ?? ''
        const val = fieldValues[fid] ?? ef?.value ?? defVal
        const orig = ef?.original_value ?? ef?.value ?? ''
        return fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal).isDefault
      }).length

      const existingList = groupMap.get(gKey)!
      const existingIdx = existingList.findIndex(it => it.clauseNum === res.clauseNum)
      if (existingIdx < 0) {
        existingList.push({
          id: tSec.section_id,
          clauseNum: res.clauseNum,
          clauseTitle: res.clauseTitle,
          source: 'tmpl',
          tmplSec: tSec,
          fieldIds: uniqueFids,
          defaultCount: defCount,
        })
      }
    }

    // Assemble final SectionGroup array with nested branch grouping
    const result: SectionGroup[] = []
    let groupIdx = 1

    for (const tocItem of tocList) {
      const rawItems = groupMap.get(tocItem.key) || []
      // Sort items by natural clause numbering
      rawItems.sort((a, b) => compareClauses(a.clauseNum, b.clauseNum))

      // Group items by branch key (e.g. 4.5, 4.2, 4.6, 2.3, etc.)
      const branchMap = new Map<string, GroupSectionItem[]>()
      for (const it of rawItems) {
        const bKey = getBranchKey(it.clauseNum)
        if (!branchMap.has(bKey)) {
          branchMap.set(bKey, [])
        }
        branchMap.get(bKey)!.push(it)
      }

      const branches: SectionBranch[] = []
      const visibleAllItems: GroupSectionItem[] = []

      for (const [bKey, rawBranchItems] of branchMap.entries()) {
        // Filter out empty placeholder headings if sub-branches exist
        const bItems = rawBranchItems.filter(it => {
          if (it.clauseNum === bKey && rawBranchItems.length > 1) {
            const hasBlocks = (it.btSec?.blocks?.length ?? 0) > 0
            const hasFields = it.fieldIds.length > 0
            return hasBlocks || hasFields
          }
          return true
        })

        if (bItems.length === 0) continue

        visibleAllItems.push(...bItems)

        const branchTitle =
          CANONICAL_BRANCH_TITLES[bKey] ||
          bItems.find(x => x.clauseNum === bKey)?.clauseTitle ||
          bItems[0]?.clauseTitle ||
          bKey

        const isBranchContainer = bItems.length > 1
        const bTotal = bItems.length
        const bDefaults = bItems.reduce((acc, it) => acc + it.defaultCount, 0)

        const bHasMatchingFilter =
          activeFilter === 'all' ||
          bItems.some(it => {
            return it.fieldIds.some(fid => {
              const ef = extractedMap.get(fid)
              const defVal = ef?.default_value ?? ''
              const val = fieldValues[fid] ?? ef?.value ?? defVal
              const orig = ef?.original_value ?? ef?.value ?? ''
              const { isDefault, isReview, isVerified } = fieldStatus(val, orig, confidencePct(ef), ef?.validation_status, defVal)
              if (activeFilter === 'default' && isDefault) return true
              if (activeFilter === 'review' && isReview) return true
              if (activeFilter === 'verified' && isVerified) return true
              return false
            })
          })

        branches.push({
          branchKey: bKey,
          branchNum: bKey,
          branchTitle,
          items: bItems,
          isBranchContainer,
          totalSections: bTotal,
          defaultCount: bDefaults,
          hasMatchingFilter: bHasMatchingFilter,
        })
      }

      const totalSections = visibleAllItems.length
      const totalDefaults = visibleAllItems.reduce((acc, it) => acc + it.defaultCount, 0)
      const hasMatchingFilter = branches.some(b => b.hasMatchingFilter)

      result.push({
        groupKey: tocItem.key,
        groupIndex: groupIdx++,
        groupNum: tocItem.num,
        groupTitle: tocItem.title,
        branches,
        sections: visibleAllItems,
        totalSections,
        defaultCount: totalDefaults,
        hasMatchingFilter,
      })
    }

    return result
  }, [template, job, unmappedTmplSections, tmplSectionMap, fieldValues, extractedMap, activeFilter])

  // Default when open: All main groups open so 1.0 and main sub-branches are visible, but branch containers and cards collapsed
  useEffect(() => {
    if (unifiedSectionGroups.length > 0 && !groupsInitialized) {
      const allG = new Set<string>()
      unifiedSectionGroups.forEach(grp => allG.add(grp.groupKey))
      setExpandedGroups(allG)
      setExpandedBranches(new Set())
      setExpandedCards(new Set())
      setGroupsInitialized(true)
    }
  }, [unifiedSectionGroups, groupsInitialized])

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

  const toggleGroup = (gKey: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(gKey)) next.delete(gKey)
      else next.add(gKey)
      return next
    })
  }

  const toggleCard = (cardId: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }

  const toggleBranch = (branchKey: string) => {
    setExpandedBranches(prev => {
      const next = new Set(prev)
      if (next.has(branchKey)) next.delete(branchKey)
      else next.add(branchKey)
      return next
    })
  }

  const expandAll = () => {
    const allG = new Set<string>()
    const allB = new Set<string>()
    const allC = new Set<string>()
    unifiedSectionGroups.forEach(grp => {
      allG.add(grp.groupKey)
      grp.branches.forEach(b => allB.add(b.branchKey))
      grp.sections.forEach(s => allC.add(s.id))
    })
    setExpandedGroups(allG)
    setExpandedBranches(allB)
    setExpandedCards(allC)
  }

  const collapseAll = () => {
    // Keep main groups open so 1.0 and all main sub-branches are visible, collapse branch containers and cards
    const allG = new Set<string>()
    unifiedSectionGroups.forEach(grp => allG.add(grp.groupKey))
    setExpandedGroups(allG)
    setExpandedBranches(new Set())
    setExpandedCards(new Set())
  }

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

            {/* Filter Dropdown (Reference Image) */}
            <div className="relative" ref={filterRef}>
              <button
                type="button"
                onClick={() => setFilterDropdownOpen(p => !p)}
                className={`px-3.5 py-2 text-xs font-semibold rounded-xl border transition-all flex items-center gap-2 ${
                  filterDropdownOpen || activeFilter !== 'all'
                    ? 'bg-blue-50 text-blue-700 border-blue-300 ring-2 ring-blue-500/20 shadow-2xs'
                    : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
                }`}
              >
                <Filter className="w-3.5 h-3.5 text-slate-500" />
                <span>Filter</span>
                {filterDropdownOpen ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                )}
              </button>

              {/* Filter Options Popover */}
              {filterDropdownOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-2xl shadow-xl border border-slate-100 p-2 z-50 animate-in fade-in zoom-in-95 duration-150">
                  <div className="px-3 pt-2 pb-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    FILTER OPTIONS
                  </div>
                  <div className="space-y-1 mt-1">
                    {/* All Parameters */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveFilter('all')
                        setFilterDropdownOpen(false)
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors ${
                        activeFilter === 'all'
                          ? 'bg-blue-50/70 text-blue-700 font-bold'
                          : 'text-slate-700 hover:bg-slate-50 font-medium'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <FileText className="w-4 h-4 text-blue-500" />
                        <span>All Parameters</span>
                      </div>
                      <span className="text-xs font-bold text-slate-600">{stats.total}</span>
                    </button>

                    {/* Default */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveFilter('default')
                        setFilterDropdownOpen(false)
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors ${
                        activeFilter === 'default'
                          ? 'bg-indigo-50/70 text-indigo-700 font-bold'
                          : 'text-slate-700 hover:bg-slate-50 font-medium'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <ClipboardList className="w-4 h-4 text-indigo-600" />
                        <span>Default</span>
                      </div>
                      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-100">
                        {stats.defaultCount}
                      </span>
                    </button>

                    {/* Review */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveFilter('review')
                        setFilterDropdownOpen(false)
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors ${
                        activeFilter === 'review'
                          ? 'bg-amber-50/70 text-amber-700 font-bold'
                          : 'text-slate-700 hover:bg-slate-50 font-medium'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <AlertTriangle className="w-4 h-4 text-amber-500" />
                        <span>Review</span>
                      </div>
                      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-100">
                        {stats.review}
                      </span>
                    </button>

                    {/* Verified */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveFilter('verified')
                        setFilterDropdownOpen(false)
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors ${
                        activeFilter === 'verified'
                          ? 'bg-emerald-50/70 text-emerald-700 font-bold'
                          : 'text-slate-700 hover:bg-slate-50 font-medium'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        <span>Verified</span>
                      </div>
                      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-100">
                        {stats.verified}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── 3. Grouped Section Accordions (Reference Images 3 & 4) ── */}
        <div className="space-y-4">
          {unifiedSectionGroups.map(grp => (
            <TopLevelGroupAccordion
              key={grp.groupKey}
              grp={grp}
              expanded={expandedGroups.has(grp.groupKey)}
              onToggle={() => toggleGroup(grp.groupKey)}
              expandedBranches={expandedBranches}
              onToggleBranch={toggleBranch}
              expandedCards={expandedCards}
              onToggleCard={toggleCard}
              jobId={jobId!}
              extractedMap={extractedMap}
              fieldValues={fieldValues}
              activeFilter={activeFilter}
              searchQuery={searchQuery}
              onFieldChange={handleFieldChange}
              onSave={handleSaveField}
              onSaveSection={handleSaveSection}
              onBlockUpdate={handleBlockUpdate}
              onBlockTableUpdate={handleBlockTableUpdate}
              enableStaticEditing={true}
              savingSections={savingSections}
            />
          ))}

          {unifiedSectionGroups.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center text-slate-400 text-sm shadow-sm">
              No sections found in document. Please run extraction.
            </div>
          )}
        </div>
      </main>


    </div>
  )
}
