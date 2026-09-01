import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  transformWithAI,
  exportRealtimeDocument,
  getTemplates,
  getTemplate,
  getProject,
  getExtractionExportUrl,
} from '../services/api'
import type { TemplateListResponse, ProjectDetailResponse } from '../types'

interface DocumentSection {
  id: string
  number?: string
  name: string
  badge?: string
  content: string
  originalContent: string
  isSaved?: boolean
  fields?: Array<{
    field_id: string
    field_label: string
    value: string
    default_value?: string
    clause_ref?: string
    data_type?: string
    required?: boolean
    extraction_hint?: string
  }>
}

const DEFAULT_SECTIONS: DocumentSection[] = [
  {
    id: 'executive_summary',
    name: 'EXECUTIVE SUMMARY',
    badge: 'Key Highlights',
    content: '<p>This engineering document defines the design basis, technical parameters, and specification requirements for Momentive Performance Materials, Chennai (Pashmina Project). All electrical systems, distribution boards, switchgear, and safety interlocks conform to applicable national and international standards (IS / IEC / IEEE).</p>',
    originalContent: '<p>This engineering document defines the design basis, technical parameters, and specification requirements for Momentive Performance Materials, Chennai (Pashmina Project). All electrical systems, distribution boards, switchgear, and safety interlocks conform to applicable national and international standards (IS / IEC / IEEE).</p>',
  },
  {
    id: 'revision_index',
    name: 'REVISION INDEX',
    content: '<table border="1" style="width:100%; border-collapse:collapse; text-align:center; font-size:12px;"><thead><tr style="background:#f1f5f9;"><th>REV</th><th>DESCRIPTION</th><th>PREP\'D</th><th>CKD</th><th>APPR\'D</th><th>DATE</th></tr></thead><tbody><tr><td>0</td><td style="text-align:left; padding-left:8px;">ISSUE FOR ENGINEERING</td><td>SAM</td><td>KP</td><td>NVS</td><td>Nov 23, 07</td></tr><tr><td>P</td><td style="text-align:left; padding-left:8px;">PRELIMINARY DESIGN DRAFT</td><td>ENG</td><td>SR</td><td>MGR</td><td>Aug 15, 07</td></tr></tbody></table>',
    originalContent: '<table border="1" style="width:100%; border-collapse:collapse; text-align:center; font-size:12px;"><thead><tr style="background:#f1f5f9;"><th>REV</th><th>DESCRIPTION</th><th>PREP\'D</th><th>CKD</th><th>APPR\'D</th><th>DATE</th></tr></thead><tbody><tr><td>0</td><td style="text-align:left; padding-left:8px;">ISSUE FOR ENGINEERING</td><td>SAM</td><td>KP</td><td>NVS</td><td>Nov 23, 07</td></tr><tr><td>P</td><td style="text-align:left; padding-left:8px;">PRELIMINARY DESIGN DRAFT</td><td>ENG</td><td>SR</td><td>MGR</td><td>Aug 15, 07</td></tr></tbody></table>',
  },
  {
    id: 'abbreviations',
    name: 'ABBREVIATIONS',
    content: '<p><strong>HV:</strong> High Voltage (6.6 kV / 11 kV)<br><strong>LV:</strong> Low Voltage (415 V)<br><strong>MCC:</strong> Motor Control Centre<br><strong>PCC:</strong> Power Control Centre<br><strong>VFD:</strong> Variable Frequency Drive<br><strong>ACB:</strong> Air Circuit Breaker<br><strong>VCB:</strong> Vacuum Circuit Breaker</p>',
    originalContent: '<p><strong>HV:</strong> High Voltage (6.6 kV / 11 kV)<br><strong>LV:</strong> Low Voltage (415 V)<br><strong>MCC:</strong> Motor Control Centre<br><strong>PCC:</strong> Power Control Centre<br><strong>VFD:</strong> Variable Frequency Drive<br><strong>ACB:</strong> Air Circuit Breaker<br><strong>VCB:</strong> Vacuum Circuit Breaker</p>',
  },
  {
    id: 'scope_of_work',
    number: '1',
    name: 'SCOPE OF WORK',
    badge: 'Section 1',
    content: '<p>The Scope of work is to carry out the detailed electrical design, equipment sizing, protection coordination, and specification preparation for Momentive Performance Materials, Pashmina Project, Chennai. The contractor shall supply, test, calibrate, and commission the 6.6kV switchboards and 415V distribution system in strict adherence to client requirements.</p>',
    originalContent: '<p>The Scope of work is to carry out the detailed electrical design, equipment sizing, protection coordination, and specification preparation for Momentive Performance Materials, Pashmina Project, Chennai. The contractor shall supply, test, calibrate, and commission the 6.6kV switchboards and 415V distribution system in strict adherence to client requirements.</p>',
  },
  {
    id: 'site_conditions',
    number: '2',
    name: 'SITE CONDITIONS & ENVIRONMENTAL DATA',
    badge: 'Section 2',
    content: '<p><strong>Design Ambient Temperature:</strong> 45°C<br><strong>Relative Humidity:</strong> 95% maximum<br><strong>Altitude:</strong> Less than 1000m above MSL<br><strong>Atmosphere:</strong> Highly humid, tropical, and mildly corrosive industrial environment.<br><strong>Seismic Zone:</strong> Zone III as per IS 1893.</p>',
    originalContent: '<p><strong>Design Ambient Temperature:</strong> 45°C<br><strong>Relative Humidity:</strong> 95% maximum<br><strong>Altitude:</strong> Less than 1000m above MSL<br><strong>Atmosphere:</strong> Highly humid, tropical, and mildly corrosive industrial environment.<br><strong>Seismic Zone:</strong> Zone III as per IS 1893.</p>',
  },
  {
    id: 'technical_specifications',
    number: '3',
    name: 'TECHNICAL SPECIFICATIONS & RATINGS',
    badge: 'Section 3',
    content: '<p><strong>System Voltage:</strong> 6.6 kV ± 10%, 3 Phase, 3 Wire, 50 Hz ± 5%<br><strong>Fault Level:</strong> 25 kA for 1 second<br><strong>Busbar Rating:</strong> Electrolytic grade high-conductivity Copper / Aluminum, 1600A<br><strong>Degree of Protection:</strong> IP42 for indoor switchboards, IP55 for outdoor marshaling kiosks.<br><strong>Control Voltage:</strong> 110 V DC for tripping and closing circuits.</p>',
    originalContent: '<p><strong>System Voltage:</strong> 6.6 kV ± 10%, 3 Phase, 3 Wire, 50 Hz ± 5%<br><strong>Fault Level:</strong> 25 kA for 1 second<br><strong>Busbar Rating:</strong> Electrolytic grade high-conductivity Copper / Aluminum, 1600A<br><strong>Degree of Protection:</strong> IP42 for indoor switchboards, IP55 for outdoor marshaling kiosks.<br><strong>Control Voltage:</strong> 110 V DC for tripping and closing circuits.</p>',
  },
]

export default function CustomDocumentEditor() {
  const { projectId } = useParams<{ projectId?: string }>()
  const navigate = useNavigate()

  // Document & Template state
  const [selectedTemplate, setSelectedTemplate] = useState<string>('specification_01')
  const [sections, setSections] = useState<DocumentSection[]>(DEFAULT_SECTIONS)
  const [openSectionId, setOpenSectionId] = useState<string>('scope_of_work')
  const [docTitle, setDocTitle] = useState('ELECTRICAL DESIGN BASIS')
  const [specNumber, setSpecNumber] = useState('IP009-43-00-01-0')
  const [projectName, setProjectName] = useState('PASHMINA PROJECT')
  const [clientName, setClientName] = useState('MOMENTIVE PERFORMANCE MATERIALS')
  const [locationName, setLocationName] = useState('CHENNAI')
  const [revision, setRevision] = useState('0')

  // Editor states
  const editorRef = useRef<HTMLDivElement>(null)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiStatus, setAiStatus] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [showTableModal, setShowTableModal] = useState(false)
  const [showLinkModal, setShowLinkModal] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [tableRows, setTableRows] = useState(3)
  const [tableCols, setTableCols] = useState(3)
  const [history, setHistory] = useState<Record<string, string[]>>({})
  const [historyIndex, setHistoryIndex] = useState<Record<string, number>>({})

  // Helper to build sections from backend template schema and extracted values
  const buildSectionsFromSchema = (schema: any, extractedValuesMap: Record<string, string> = {}): DocumentSection[] => {
    const rawSections = schema?.sections || []
    if (!Array.isArray(rawSections) || rawSections.length === 0) {
      return DEFAULT_SECTIONS
    }

    return rawSections.map((sec: any, idx: number) => {
      const secId = sec.section_id || `sec_${idx}`
      const secName = sec.section_name || `Section ${idx + 1}`
      const secNum = sec.section_number || String(idx + 1)
      const rawFields = Array.isArray(sec.fields) ? sec.fields : []

      const fields = rawFields.map((f: any) => {
        const fid = f.field_id
        const extractedVal = extractedValuesMap[fid]
        const val = extractedVal !== undefined && extractedVal !== null && extractedVal !== ''
          ? extractedVal
          : (f.default_value ?? f.value ?? '')
        return {
          field_id: fid,
          field_label: f.field_label || f.label || fid,
          clause_ref: f.clause_ref,
          data_type: f.data_type,
          required: f.required,
          extraction_hint: f.extraction_hint,
          default_value: f.default_value,
          value: val,
        }
      })

      let htmlContent = `<div class="template-section">`
      if (sec.note) {
        htmlContent += `<p style="font-style:italic; color:#64748b; margin-bottom:8px;">${sec.note}</p>`
      }
      if (fields.length > 0) {
        htmlContent += `<table border="1" style="width:100%; border-collapse:collapse; font-size:13px; margin:8px 0;">`
        htmlContent += `<thead><tr style="background:#1A3A6B; color:white;"><th style="padding:6px 10px; text-align:left; width:35%;">FIELD / PARAMETER</th><th style="padding:6px 10px; text-align:left;">VALUE</th></tr></thead><tbody>`
        fields.forEach((f: any, fIdx: number) => {
          const bg = fIdx % 2 === 0 ? '#f8fafc' : '#ffffff'
          const clause = f.clause_ref ? `<span style="font-size:10px; color:#b45309; background:#fef3c7; padding:1px 4px; border-radius:3px; margin-left:4px;">§ ${f.clause_ref}</span>` : ''
          htmlContent += `<tr style="background:${bg};"><td style="padding:6px 10px; font-weight:600; border:1px solid #cbd5e1;">${f.field_label} ${clause}</td><td style="padding:6px 10px; border:1px solid #cbd5e1;">${f.value || '—'}</td></tr>`
        })
        htmlContent += `</tbody></table>`
      } else {
        htmlContent += `<p style="color:#475569;">Standard clause requirements for ${secName}.</p>`
      }
      htmlContent += `</div>`

      return {
        id: secId,
        number: secNum,
        name: secName,
        badge: `Section ${secNum}`,
        fields: fields,
        content: htmlContent,
        originalContent: htmlContent,
      }
    })
  }

  // Load project or template data on mount or change
  useEffect(() => {
    async function loadData() {
      let tplIdToFetch = selectedTemplate
      let extractedValuesMap: Record<string, string> = {}

      if (projectId) {
        try {
          const proj = await getProject(Number(projectId))
          if (proj) {
            setProjectName(proj.project_name || 'PASHMINA PROJECT')
            if (proj.extraction_jobs && proj.extraction_jobs.length > 0) {
              const activeJob = proj.extraction_jobs[0]
              if (activeJob.template_code) setSpecNumber(activeJob.template_code)
              if (activeJob.template_name) setDocTitle(activeJob.template_name)
              if (activeJob.template_id) {
                // Number id or string template_id
                tplIdToFetch = typeof activeJob.template_id === 'string' ? activeJob.template_id : `specification_0${activeJob.template_id}`
              }
              if (activeJob.extracted_fields) {
                activeJob.extracted_fields.forEach((ef) => {
                  if (ef.field_id) {
                    extractedValuesMap[ef.field_id] = ef.value ?? ''
                  }
                })
              }
            }
          }
        } catch {
          /* ignore error */
        }
      }

      // Fetch actual template schema from API
      try {
        const schema = await getTemplate(tplIdToFetch)
        if (schema && schema.sections) {
          if (schema.template_name) setDocTitle(schema.template_name)
          if (schema.specification_number) setSpecNumber(schema.specification_number)
          const parsedSecs = buildSectionsFromSchema(schema, extractedValuesMap)
          setSections(parsedSecs)
          if (parsedSecs.length > 0) {
            setOpenSectionId(parsedSecs[0].id)
          }
          return
        }
      } catch {
        /* Fallback if schema fetch fails */
      }

      if (selectedTemplate === 'specification_02') {
        setDocTitle('SPECIFICATION FOR 6.6kV SWITCHBOARD')
        setSpecNumber('IP009-43-03-01-P')
        setRevision('P')
      } else if (selectedTemplate === 'specification_03') {
        setDocTitle('SPECIFICATION FOR M.V. SWITCH BOARD')
        setSpecNumber('IP009-43-03-02-0')
        setRevision('0')
      } else if (!projectId) {
        setDocTitle('ELECTRICAL DESIGN BASIS')
        setSpecNumber('IP009-43-00-01-0')
        setRevision('0')
      }
    }
    loadData()
  }, [selectedTemplate, projectId])

  // Sync contentEditable with current open section
  const currentSection = sections.find((s) => s.id === openSectionId)

  useEffect(() => {
    if (editorRef.current && currentSection) {
      if (editorRef.current.innerHTML !== currentSection.content) {
        editorRef.current.innerHTML = currentSection.content
      }
    }
  }, [openSectionId])

  // Formatting commands with native document.execCommand / DOM manipulation
  const execCmd = (command: string, val: string | undefined = undefined) => {
    if (!editorRef.current) return
    editorRef.current.focus()
    document.execCommand(command, false, val)
    handleEditorInput()
  }

  const handleEditorInput = useCallback(() => {
    if (!editorRef.current || !openSectionId) return
    const newHtml = editorRef.current.innerHTML
    setSections((prev) =>
      prev.map((s) => (s.id === openSectionId ? { ...s, content: newHtml, isSaved: false } : s)),
    )
  }, [openSectionId])

  // Style change handler (Headings, Paragraph, Quote, Code)
  const handleStyleChange = (styleTag: string) => {
    if (!styleTag) return
    if (styleTag === 'p') {
      execCmd('formatBlock', '<p>')
    } else if (styleTag === 'h1') {
      execCmd('formatBlock', '<h1>')
    } else if (styleTag === 'h2') {
      execCmd('formatBlock', '<h2>')
    } else if (styleTag === 'h3') {
      execCmd('formatBlock', '<h3>')
    } else if (styleTag === 'blockquote') {
      execCmd('formatBlock', '<blockquote>')
    } else if (styleTag === 'pre') {
      execCmd('formatBlock', '<pre>')
    }
  }

  // Insert Table
  const insertTable = () => {
    if (!editorRef.current) return
    let html = '<table border="1" style="width:100%; border-collapse:collapse; margin:12px 0; font-size:13px;">'
    html += '<thead><tr style="background:#1A3A6B; color:white;">'
    for (let c = 1; c <= tableCols; c++) {
      html += `<th style="padding:6px 8px; border:1px solid #cbd5e1;">Header ${c}</th>`
    }
    html += '</tr></thead><tbody>'
    for (let r = 1; r <= tableRows; r++) {
      const bg = r % 2 === 0 ? '#f8fafc' : '#ffffff'
      html += `<tr style="background:${bg};">`
      for (let c = 1; c <= tableCols; c++) {
        html += `<td style="padding:6px 8px; border:1px solid #cbd5e1;">Row ${r}, Col ${c}</td>`
      }
      html += '</tr>'
    }
    html += '</tbody></table><p><br></p>'
    execCmd('insertHTML', html)
    setShowTableModal(false)
  }

  // Insert Link
  const insertLink = () => {
    if (!linkUrl) return
    execCmd('createLink', linkUrl)
    setLinkUrl('')
    setShowLinkModal(false)
  }

  // Insert Emoji or Engineering Symbol
  const insertSymbol = (sym: string) => {
    execCmd('insertText', sym)
    setShowEmojiPicker(false)
  }

  // Rovo-like AI Transformation
  const handleAITransform = async (customInstruction?: string) => {
    const instruction = customInstruction || aiPrompt
    if (!instruction.trim() || !currentSection || !editorRef.current) return

    setAiLoading(true)
    setAiStatus(`Applying AI instruction: "${instruction}"...`)
    try {
      const selectedText = window.getSelection()?.toString()
      const textToTransform = selectedText && selectedText.trim().length > 3 ? selectedText : editorRef.current.innerHTML

      const res = await transformWithAI({
        text: textToTransform,
        instruction,
        section_name: currentSection.name,
      })

      if (res && res.result) {
        if (selectedText && selectedText.trim().length > 3) {
          execCmd('insertHTML', res.result)
        } else {
          editorRef.current.innerHTML = res.result
          handleEditorInput()
        }
        setAiStatus(`✓ Transformed successfully (${res.model_used})`)
        setAiPrompt('')
      }
    } catch (err) {
      setAiStatus(`AI transform error: ${(err as Error).message}`)
    } finally {
      setAiLoading(false)
      setTimeout(() => setAiStatus(null), 4000)
    }
  }

  // Save current section
  const handleSaveSection = () => {
    setSections((prev) =>
      prev.map((s) => (s.id === openSectionId ? { ...s, isSaved: true } : s)),
    )
    setAiStatus('✓ Section content saved to project!')
    setTimeout(() => setAiStatus(null), 3000)
  }

  // Reset current section to original
  const handleResetSection = () => {
    if (!currentSection || !editorRef.current) return
    editorRef.current.innerHTML = currentSection.originalContent
    setSections((prev) =>
      prev.map((s) =>
        s.id === openSectionId ? { ...s, content: s.originalContent, isSaved: true } : s,
      ),
    )
    setAiStatus('Section reset to original extracted value.')
    setTimeout(() => setAiStatus(null), 3000)
  }

  // Export Document (Real-time PDF / DOCX / JSON via backend LibreOffice & python-docx)
  const handleDownload = async (format: 'pdf' | 'docx' | 'json') => {
    setExporting(true)
    try {
      const payload = {
        title: docTitle,
        subtitle: `${projectName} - ${clientName}, ${locationName}`,
        project_meta: {
          spec_no: specNumber,
          revision: revision,
          project_no: 'IP009',
        },
        sections: sections.map((s, idx) => ({
          section_number: s.number || String(idx + 1),
          section_name: s.name,
          content: s.content,
        })),
        format,
      }

      if (format === 'json') {
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2))
        const a = document.createElement('a')
        a.href = dataStr
        a.download = `${docTitle.replace(/\s+/g, '_').toLowerCase()}_realtime.json`
        a.click()
        return
      }

      const blob = await exportRealtimeDocument(payload)
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${docTitle.replace(/\s+/g, '_').toLowerCase()}_realtime.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch (err) {
      alert(`Export error: ${(err as Error).message}. Falling back to browser print.`);
      if (format === 'pdf') {
        window.print()
      }
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans">
      {/* ─────────────────────────────────────────────────────────────
          1. TOP APP BAR (AmperePro Branding & Header matching screenshot)
      ───────────────────────────────────────────────────────────── */}
      <header className="bg-[#1A3A6B] text-white px-6 py-2.5 flex items-center justify-between shadow-md z-30">
        <div className="flex items-center gap-3">
          <div className="bg-white rounded px-2 py-1 flex items-center shadow-sm">
            <span className="font-extrabold text-[#1A3A6B] text-sm tracking-tight flex items-center gap-1">
              ⚡ AmperePro
            </span>
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide">AmperePro Engineers India Pvt. Ltd.</h1>
            <p className="text-[10px] text-blue-200">Empowering Solutions, Electrifying Results</p>
          </div>
        </div>

        {/* Template Switcher & Project Quick Actions */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 bg-[#12294d] px-3 py-1.5 rounded-lg border border-blue-400/20">
            <span className="text-blue-200 font-medium">Template:</span>
            <select
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
              className="bg-transparent text-white font-medium focus:outline-none cursor-pointer"
            >
              <option value="specification_01" className="text-slate-900">Spec 01: Electrical Design Basis</option>
              <option value="specification_02" className="text-slate-900">Spec 02: 6.6kV Switchboard</option>
              <option value="specification_03" className="text-slate-900">Spec 03: M.V. Switch Board</option>
            </select>
          </div>

          <a href="#calculations" className="text-blue-100 hover:text-white transition-colors">
            Ampere Pro Calculations
          </a>

          <button
            onClick={() => handleDownload('docx')}
            disabled={exporting}
            className="px-3 py-1 bg-white/10 hover:bg-white/20 text-white rounded font-medium transition-colors border border-white/20 flex items-center gap-1.5"
            title="Download Realtime Word Document"
          >
            DOCX
          </button>

          <button
            onClick={() => handleDownload('pdf')}
            disabled={exporting}
            className="px-3 py-1 bg-[#F97316] hover:bg-[#ea6a0c] text-white rounded font-medium transition-colors shadow-sm flex items-center gap-1.5"
            title="Download Realtime PDF Report"
          >
            {exporting ? 'Generating...' : 'PDF Export'}
          </button>

          <button
            onClick={() => navigate('/')}
            className="px-3 py-1 bg-blue-900/60 hover:bg-blue-900 text-blue-200 hover:text-white rounded transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      {/* ─────────────────────────────────────────────────────────────
          2. MAIN CONTENT AREA (Document Accordions & Rovo-like Editor)
      ───────────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-6 space-y-4">
        {/* Document Header Banner */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex items-center justify-between">
          <div>
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Spec No: {specNumber} · Rev: {revision}</span>
            <h2 className="text-lg font-bold text-slate-800">{docTitle}</h2>
            <p className="text-xs text-slate-500">{projectName} · {clientName} · {locationName}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2.5 py-1 bg-green-50 text-green-700 border border-green-200 rounded-full font-medium flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500"></span> Realtime Sync Active
            </span>
          </div>
        </div>

        {/* Accordion Sections List */}
        <div className="space-y-3">
          {sections.map((sec) => {
            const isOpen = openSectionId === sec.id

            return (
              <div
                key={sec.id}
                className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all duration-200"
              >
                {/* Accordion Header */}
                <button
                  type="button"
                  onClick={() => setOpenSectionId(isOpen ? '' : sec.id)}
                  className={`w-full px-6 py-4 flex items-center justify-between text-left transition-colors ${
                    isOpen ? 'bg-slate-50 border-b border-slate-200' : 'hover:bg-slate-50/70'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {sec.number && (
                      <span className="text-sm font-bold text-slate-900 w-5">{sec.number}</span>
                    )}
                    <span className="text-sm font-bold tracking-wide text-slate-800">
                      {sec.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    {sec.badge && (
                      <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
                        {sec.badge}
                      </span>
                    )}
                    {sec.isSaved && (
                      <span className="text-[10px] text-green-600 font-semibold">✓ Saved</span>
                    )}
                    <span className="text-slate-400 text-xs transform transition-transform duration-200">
                      {isOpen ? '▲' : '▼'}
                    </span>
                  </div>
                </button>

                {/* Open Accordion Body -> TEMPLATE FORM & CUSTOM TEXT EDITOR */}
                {isOpen && (
                  <div className="p-6 bg-white space-y-4">
                    {/* ══════════════════════════════════════════════════
                        TEMPLATE STRUCTURE FORM GRID (Per Template Schema)
                    ══════════════════════════════════════════════════ */}
                    {sec.fields && sec.fields.length > 0 && (
                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
                        <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                          <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                            📋 Template Structure Form ({sec.fields.length} Parameters)
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">Matched Template Schema</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                          {sec.fields.map((f) => (
                            <div key={f.field_id} className="bg-white p-3 rounded-lg border border-slate-200 shadow-2xs space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-xs font-semibold text-slate-800 flex items-center gap-1">
                                  {f.field_label}
                                  {f.required && <span className="text-red-500">*</span>}
                                </label>
                                {f.clause_ref && (
                                  <span className="text-[9px] font-mono bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-semibold">
                                    § {f.clause_ref}
                                  </span>
                                )}
                              </div>
                              <input
                                type="text"
                                value={f.value || ''}
                                onChange={(e) => {
                                  const newVal = e.target.value
                                  setSections((prev) =>
                                    prev.map((s) => {
                                      if (s.id !== sec.id) return s
                                      const updatedFields = (s.fields || []).map((fieldItem) =>
                                        fieldItem.field_id === f.field_id ? { ...fieldItem, value: newVal } : fieldItem
                                      )
                                      let htmlContent = `<div class="template-section">`
                                      htmlContent += `<table border="1" style="width:100%; border-collapse:collapse; font-size:13px; margin:8px 0;">`
                                      htmlContent += `<thead><tr style="background:#1A3A6B; color:white;"><th style="padding:6px 10px; text-align:left; width:35%;">FIELD / PARAMETER</th><th style="padding:6px 10px; text-align:left;">VALUE</th></tr></thead><tbody>`
                                      updatedFields.forEach((uf, fIdx) => {
                                        const bg = fIdx % 2 === 0 ? '#f8fafc' : '#ffffff'
                                        const clause = uf.clause_ref ? `<span style="font-size:10px; color:#b45309; background:#fef3c7; padding:1px 4px; border-radius:3px; margin-left:4px;">§ ${uf.clause_ref}</span>` : ''
                                        htmlContent += `<tr style="background:${bg};"><td style="padding:6px 10px; font-weight:600; border:1px solid #cbd5e1;">${uf.field_label} ${clause}</td><td style="padding:6px 10px; border:1px solid #cbd5e1;">${uf.value || '—'}</td></tr>`
                                      })
                                      htmlContent += `</tbody></table></div>`
                                      return { ...s, fields: updatedFields, content: htmlContent, isSaved: false }
                                    })
                                  )
                                }}
                                placeholder={f.default_value ? `Default: ${f.default_value}` : 'Enter value...'}
                                className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 font-medium text-slate-800 bg-white"
                              />
                              {f.extraction_hint && (
                                <p className="text-[10px] text-slate-400 leading-tight">
                                  🤖 {f.extraction_hint}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* ══════════════════════════════════════════════════
                        CUSTOM IN-HOUSE EDITOR TOOLBAR (Pure Vanilla/React)
                    ══════════════════════════════════════════════════ */}
                    <div className="border border-slate-200 rounded-xl overflow-hidden shadow-xs bg-slate-50/50">
                      {/* Top Controls Row */}
                      <div className="px-3 py-2 bg-white border-b border-slate-200 flex flex-wrap items-center gap-1.5 text-slate-700">
                        {/* amperepro Badge */}
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 shadow-xs mr-1">
                          ⚡ amperepro
                        </span>

                        {/* Style Selector Dropdown */}
                        <div className="relative inline-block">
                          <select
                            onChange={(e) => handleStyleChange(e.target.value)}
                            defaultValue=""
                            className="text-xs bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded px-2.5 py-1 font-medium cursor-pointer focus:outline-none"
                          >
                            <option value="" disabled>Style ▾</option>
                            <option value="p">Normal Text</option>
                            <option value="h1">Heading 1</option>
                            <option value="h2">Heading 2</option>
                            <option value="h3">Heading 3</option>
                            <option value="blockquote">Quote</option>
                            <option value="pre">Code Block</option>
                          </select>
                        </div>

                        <span className="w-px h-4 bg-slate-200 mx-1"></span>

                        {/* Formatting: Bold, Italic, Underline, Strikethrough */}
                        <button
                          type="button"
                          onClick={() => execCmd('bold')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 font-bold text-xs"
                          title="Bold (Ctrl+B)"
                        >
                          B
                        </button>
                        <button
                          type="button"
                          onClick={() => execCmd('italic')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 italic font-serif text-xs"
                          title="Italic (Ctrl+I)"
                        >
                          I
                        </button>
                        <button
                          type="button"
                          onClick={() => execCmd('underline')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 underline text-xs"
                          title="Underline (Ctrl+U)"
                        >
                          U
                        </button>
                        <button
                          type="button"
                          onClick={() => execCmd('strikeThrough')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 line-through text-xs"
                          title="Strikethrough"
                        >
                          S
                        </button>

                        <span className="w-px h-4 bg-slate-200 mx-1"></span>

                        {/* Color Picker Dropdown (A ▾) */}
                        <div className="relative inline-block">
                          <button
                            type="button"
                            onClick={() => setShowColorPicker(!showColorPicker)}
                            className="h-7 px-2 flex items-center gap-1 rounded hover:bg-slate-100 text-xs font-semibold"
                            title="Text Color"
                          >
                            <span className="border-b-2 border-[#1A3A6B]">A</span>
                            <span className="text-[9px]">▾</span>
                          </button>
                          {showColorPicker && (
                            <div className="absolute top-8 left-0 bg-white border border-slate-200 rounded-lg p-2 shadow-lg grid grid-cols-4 gap-1.5 z-40">
                              {['#0f172a', '#1A3A6B', '#F97316', '#16a34a', '#dc2626', '#64748b', '#9333ea', '#ca8a04'].map((col) => (
                                <button
                                  key={col}
                                  type="button"
                                  onClick={() => {
                                    execCmd('foreColor', col)
                                    setShowColorPicker(false)
                                  }}
                                  className="w-5 h-5 rounded-full border border-slate-300 hover:scale-110 transition-transform"
                                  style={{ backgroundColor: col }}
                                />
                              ))}
                            </div>
                          )}
                        </div>

                        <span className="w-px h-4 bg-slate-200 mx-1"></span>

                        {/* Alignment Buttons: Left, Center, Right, Justify */}
                        <button
                          type="button"
                          onClick={() => execCmd('justifyLeft')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Align Left"
                        >
                          ≡
                        </button>
                        <button
                          type="button"
                          onClick={() => execCmd('justifyCenter')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Align Center"
                        >
                          ≢
                        </button>
                        <button
                          type="button"
                          onClick={() => execCmd('justifyRight')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Align Right"
                        >
                          ≣
                        </button>
                        <button
                          type="button"
                          onClick={() => execCmd('justifyFull')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Justify"
                        >
                          𝄘
                        </button>

                        <span className="w-px h-4 bg-slate-200 mx-1"></span>

                        {/* Lists: Bulleted & Numbered */}
                        <button
                          type="button"
                          onClick={() => execCmd('insertUnorderedList')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Bulleted List"
                        >
                          •≡
                        </button>
                        <button
                          type="button"
                          onClick={() => execCmd('insertOrderedList')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Numbered List"
                        >
                          1.≡
                        </button>

                        <span className="w-px h-4 bg-slate-200 mx-1"></span>

                        {/* Insert Tools: Link, Image, Table, Emoji */}
                        <button
                          type="button"
                          onClick={() => setShowLinkModal(true)}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Insert Link"
                        >
                          🔗
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const url = prompt('Enter Image URL:')
                            if (url) execCmd('insertImage', url)
                          }}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Insert Image"
                        >
                          🖼️
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowTableModal(true)}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Insert Table"
                        >
                          ▦
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Insert Engineering Symbols"
                        >
                          ☺
                        </button>

                        <span className="w-px h-4 bg-slate-200 mx-1"></span>

                        {/* Undo / Redo */}
                        <button
                          type="button"
                          onClick={() => execCmd('undo')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Undo (Ctrl+Z)"
                        >
                          ↺
                        </button>
                        <button
                          type="button"
                          onClick={() => execCmd('redo')}
                          className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-100 text-xs"
                          title="Redo (Ctrl+Y)"
                        >
                          ↻
                        </button>
                      </div>

                      {/* Link Modal */}
                      {showLinkModal && (
                        <div className="p-3 bg-blue-50 border-b border-blue-200 flex items-center gap-2">
                          <input
                            type="url"
                            placeholder="https://example.com"
                            value={linkUrl}
                            onChange={(e) => setLinkUrl(e.target.value)}
                            className="px-3 py-1 text-xs border border-blue-300 rounded flex-1 focus:outline-none"
                          />
                          <button
                            onClick={insertLink}
                            className="px-3 py-1 bg-blue-600 text-white rounded text-xs font-semibold"
                          >
                            Add Link
                          </button>
                          <button
                            onClick={() => setShowLinkModal(false)}
                            className="px-2 py-1 text-xs text-slate-500 hover:text-slate-800"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {/* Table Modal */}
                      {showTableModal && (
                        <div className="p-3 bg-slate-100 border-b border-slate-200 flex items-center gap-3 text-xs">
                          <span>Rows:</span>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={tableRows}
                            onChange={(e) => setTableRows(Number(e.target.value))}
                            className="w-12 px-1.5 py-0.5 border rounded"
                          />
                          <span>Cols:</span>
                          <input
                            type="number"
                            min="1"
                            max="6"
                            value={tableCols}
                            onChange={(e) => setTableCols(Number(e.target.value))}
                            className="w-12 px-1.5 py-0.5 border rounded"
                          />
                          <button
                            onClick={insertTable}
                            className="px-3 py-1 bg-[#1A3A6B] text-white rounded font-medium"
                          >
                            Insert
                          </button>
                          <button onClick={() => setShowTableModal(false)} className="text-slate-500">
                            Cancel
                          </button>
                        </div>
                      )}

                      {/* Symbol Picker */}
                      {showEmojiPicker && (
                        <div className="p-2 bg-white border-b border-slate-200 flex flex-wrap gap-1.5 text-sm">
                          {['⚡', '✓', 'Ω', 'μ', '±', '°', '®', '©', 'Δ', 'Σ', '≤', '≥', '≈', '≠', 'kva', 'kw', 'm2'].map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => insertSymbol(s)}
                              className="px-2 py-1 bg-slate-50 hover:bg-blue-100 border rounded text-xs font-mono"
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* ══════════════════════════════════════════════════
                          CONTENT EDITABLE BODY (Pure In-House Editor)
                      ══════════════════════════════════════════════════ */}
                      <div
                        ref={editorRef}
                        contentEditable
                        onInput={handleEditorInput}
                        className="p-6 min-h-[180px] focus:outline-none text-slate-800 text-sm leading-relaxed prose max-w-none bg-white"
                        style={{ fontFamily: 'Inter, Arial, sans-serif' }}
                        dangerouslySetInnerHTML={{ __html: sec.content }}
                      />

                      {/* ══════════════════════════════════════════════════
                          ROVO-LIKE AI ASSISTANT PROMPT BAR (Bottom)
                      ══════════════════════════════════════════════════ */}
                      <div className="p-3 bg-slate-50 border-t border-slate-200 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-indigo-600 text-sm">✨</span>
                          <input
                            type="text"
                            value={aiPrompt}
                            onChange={(e) => setAiPrompt(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                handleAITransform()
                              }
                            }}
                            placeholder="Type 'make formal', 'highlight keywords', 'simplify', or custom instructions..."
                            className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/20"
                            disabled={aiLoading}
                          />
                          <button
                            type="button"
                            onClick={() => handleAITransform()}
                            disabled={aiLoading || !aiPrompt.trim()}
                            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 shadow-xs"
                          >
                            {aiLoading ? '...' : '↵'}
                          </button>
                        </div>

                        {/* Quick AI Action Chips */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] text-slate-400 uppercase font-semibold">Suggestions:</span>
                          {[
                            'make formal',
                            'highlight keywords',
                            'simplify',
                            'fix grammar',
                            'summarize',
                            'convert to bullet points',
                          ].map((chip) => (
                            <button
                              key={chip}
                              type="button"
                              onClick={() => handleAITransform(chip)}
                              className="px-2 py-0.5 bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 text-slate-600 hover:text-indigo-700 rounded-full text-[11px] transition-all"
                            >
                              {chip}
                            </button>
                          ))}
                        </div>

                        {aiStatus && (
                          <div className="text-[11px] font-medium text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded">
                            {aiStatus}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Section Action Footer (Reset, Cancel, Save Content) */}
                    <div className="flex items-center justify-between pt-2">
                      <button
                        type="button"
                        onClick={handleResetSection}
                        className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 font-medium"
                      >
                        ↺ Reset Section
                      </button>

                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setOpenSectionId('')}
                          className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 rounded-lg hover:bg-slate-100 transition-colors"
                        >
                          ✕ Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveSection}
                          className="px-5 py-2 text-xs font-semibold text-white bg-[#1A3A6B] hover:bg-[#12294d] rounded-lg shadow-sm transition-all flex items-center gap-1.5"
                        >
                          ✓ Save Content
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </main>

      {/* ─────────────────────────────────────────────────────────────
          3. FLOATING REALTIME PDF DOWNLOAD BUTTON (matching user screenshot)
      ───────────────────────────────────────────────────────────── */}
      <div className="fixed bottom-6 right-6 z-40">
        <button
          type="button"
          onClick={() => handleDownload('pdf')}
          disabled={exporting}
          className="w-12 h-12 bg-white hover:bg-red-50 text-red-600 rounded-full shadow-lg border-2 border-red-500/80 flex items-center justify-center transition-transform hover:scale-105 active:scale-95 group"
          title="Download Realtime PDF Report"
        >
          <span className="text-xl group-hover:scale-110 transition-transform">📄</span>
        </button>
      </div>
    </div>
  )
}
