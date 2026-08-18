import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Badge, Button, Card } from './components/ui'
import { Icons } from './components/icons'
import { createProject, getExtraction, getTemplates, startExtraction, uploadDocument } from './services/api'
import type { ExtractionJobResponse, TemplateListResponse } from './types'

type WizardStep = 1 | 2 | 3 | 4 | 5

const STAGE_LABELS = ['Document validation', 'Document parsing', 'Text & table extraction', 'Template mapping']

export default function CreateProject() {
  const navigate = useNavigate()
  const location = useLocation()
  const presetTemplateId = (location.state as { templateId?: string } | null)?.templateId

  const [step, setStep] = useState<WizardStep>(1)
  const [error, setError] = useState<string | null>(null)

  // Step 1
  const [projectName, setProjectName] = useState('')

  // Step 2
  const [templates, setTemplates] = useState<TemplateListResponse[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(true)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(presetTemplateId ?? null)

  // Created project id
  const [projectId, setProjectId] = useState<number | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)

  // Step 3
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [documentId, setDocumentId] = useState<number | null>(null)

  // Step 4
  const [job, setJob] = useState<ExtractionJobResponse | null>(null)
  const [startingExtraction, setStartingExtraction] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setTemplatesLoading(true)
      try {
        const result = await getTemplates()
        if (!cancelled) setTemplates(result)
      } catch (err) {
        if (!cancelled) setError(`Could not load templates: ${(err as Error).message}`)
      } finally {
        if (!cancelled) setTemplatesLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  // Poll extraction job while processing
  useEffect(() => {
    if (step !== 4 || !job || job.status === 'completed' || job.status === 'failed') return
    const timer = window.setInterval(async () => {
      try {
        const updated = await getExtraction(job.id)
        setJob(updated)
        if (updated.status === 'completed') {
          window.clearInterval(timer)
          setStep(5)
        } else if (updated.status === 'failed') {
          window.clearInterval(timer)
          setError(`Extraction failed: ${updated.error_message || 'Unknown error'}`)
        }
      } catch (err) {
        setError(`Polling failed: ${(err as Error).message}`)
        window.clearInterval(timer)
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [step, job])

  const selectedTemplate = templates.find((t) => t.template_id === selectedTemplateId) ?? null

  async function handleStep1Continue() {
    if (!projectName.trim()) return
    setStep(2)
  }

  async function handleStep2Continue() {
    if (!selectedTemplateId) return
    setError(null)
    setCreatingProject(true)
    try {
      const project = await createProject({ project_name: projectName.trim(), template_id: selectedTemplateId })
      setProjectId(project.id)
      setStep(3)
    } catch (err) {
      setError(`Could not create project: ${(err as Error).message}`)
    } finally {
      setCreatingProject(false)
    }
  }

  async function handleUploadAndProcess() {
    if (!file || !projectId) return
    setError(null)
    setUploading(true)
    try {
      const document = await uploadDocument(projectId, file)
      setDocumentId(document.id)
      setStartingExtraction(true)
      const createdJob = await startExtraction(projectId, { document_id: document.id })
      setJob(createdJob)
      setStep(4)
    } catch (err) {
      setError(`Could not process document: ${(err as Error).message}`)
    } finally {
      setUploading(false)
      setStartingExtraction(false)
    }
  }

  const stageIndex = job ? Math.min(STAGE_LABELS.length - 1, Math.floor((job.progress / 100) * STAGE_LABELS.length)) : 0

  const fieldsTotal = job?.extracted_fields?.length ?? 0
  const fieldsWithValue = job?.extracted_fields?.filter((f: any) => f.value != null && f.value !== '').length ?? 0
  const fieldsMissing = fieldsTotal - fieldsWithValue

  return (
    <div className="h-full flex flex-col">
      <div className="px-8 py-4 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between max-w-5xl mx-auto">
          {[1, 2, 3, 4].map((s) => (
            <React.Fragment key={s}>
              <div className="flex items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium border-2 ${
                    step === s
                      ? 'border-blue-600 text-blue-600 bg-blue-50'
                      : step > s
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-300 text-slate-400 bg-white'
                  }`}
                >
                  {step > s ? <Icons.Check className="w-4 h-4" /> : s}
                </div>
                <span className={`ml-3 text-sm font-medium ${step >= s ? 'text-slate-900' : 'text-slate-400'}`}>
                  {s === 1 ? 'Details' : s === 2 ? 'Template' : s === 3 ? 'Upload' : 'Review'}
                </span>
              </div>
              {s < 4 && <div className={`flex-1 mx-4 h-0.5 ${step > s ? 'bg-blue-600' : 'bg-slate-200'}`} />}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8 bg-slate-50">
        {error ? (
          <div className="max-w-2xl mx-auto mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
            {error}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="max-w-2xl mx-auto">
            <h2 className="text-xl font-semibold mb-6">Project Details</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Project Name *</label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="e.g. Airport Terminal Expansion"
                  className="w-full rounded-md border border-slate-300 p-2.5 text-sm focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div className="mt-8 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => navigate('/')}>
                Cancel
              </Button>
              <Button onClick={handleStep1Continue} disabled={!projectName.trim()}>
                Save &amp; Continue
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="max-w-5xl mx-auto">
            <div className="mb-6">
              <h2 className="text-xl font-semibold">Select Master Template</h2>
              <p className="text-slate-500 text-sm mt-1">Choose the specification structure that will be used for this project.</p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex items-start">
              <div className="text-amber-500 mt-0.5 mr-3">
                <Icons.Lock />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-amber-900">MASTER TEMPLATE PROTECTION</h4>
                <p className="text-sm text-amber-800 mt-1">
                  The selected master template defines the final structured output. The template structure will not change
                  during document processing &mdash; only values extracted from the source document are populated.
                </p>
              </div>
            </div>

            {templatesLoading ? (
              <p className="text-sm text-slate-500">Loading templates...</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {templates.map((t) => {
                  const fields = (t.sections ?? []).reduce((sum: number, s: any) => sum + s.fields.length, 0)
                  const isSelected = selectedTemplateId === t.template_id
                  return (
                    <Card
                      key={t.template_id}
                      className={`p-5 transition-all ${isSelected ? 'ring-2 ring-blue-500 border-blue-500' : 'hover:border-slate-300'}`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div className="text-xs font-semibold text-slate-500 bg-slate-100 px-2 py-1 rounded">{t.template_id}</div>
                        <Badge type="active">ACTIVE</Badge>
                      </div>
                      <h3 className="text-lg font-semibold text-slate-900 mt-2">{t.template_name}</h3>
                      <p className="text-sm text-slate-500 mt-1 line-clamp-2 h-10">{t.description || 'No description available.'}</p>
                      <div className="text-xs text-slate-500 mt-4 pt-4 border-t border-slate-100 flex gap-4">
                        <span>Version {t.version}</span>
                        <span>{fields} fields</span>
                        <span>{(t.sections ?? []).length} sections</span>
                      </div>
                      <div className="mt-5 flex gap-2 w-full">
                        <Button
                          variant={isSelected ? 'primary' : 'secondary'}
                          className="flex-1"
                          onClick={() => setSelectedTemplateId(t.template_id)}
                        >
                          {isSelected ? 'Selected' : 'Select'}
                        </Button>
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}

            <div className="mt-8 flex justify-between items-center">
              <Button variant="ghost" onClick={() => setStep(1)}>
                <Icons.ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button onClick={handleStep2Continue} disabled={!selectedTemplateId || creatingProject}>
                {creatingProject ? 'Creating project...' : 'Continue to Upload'} <Icons.ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="max-w-3xl mx-auto">
            <div className="mb-6 text-center">
              <h2 className="text-xl font-semibold">Upload Source Document</h2>
              <p className="text-slate-500 text-sm mt-1">
                Upload the unstructured document that will be mapped to {selectedTemplate?.template_name ?? 'the selected template'}.
              </p>
            </div>

            {!file ? (
              <label
                htmlFor="doc-upload"
                className="border-2 border-dashed border-slate-300 rounded-xl p-12 flex flex-col items-center justify-center bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <Icons.Upload />
                <h3 className="text-lg font-medium text-slate-900 mt-4">Drag &amp; Drop your document here</h3>
                <p className="text-slate-500 mt-1 text-sm">or click to browse files</p>
                <div className="mt-6 flex flex-col items-center text-xs text-slate-400">
                  <span>Supported formats: PDF, DOC, DOCX, Scanned Documents</span>
                  <span className="mt-1">Maximum size: 500 MB</span>
                </div>
                <input
                  id="doc-upload"
                  type="file"
                  accept=".pdf,.docx,.doc,.png,.jpg,.jpeg,.tiff,.bmp"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            ) : (
              <Card className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <div className="bg-blue-50 p-3 rounded-lg mr-4">
                      <Icons.File />
                    </div>
                    <div>
                      <h4 className="font-medium text-slate-900">{file.name}</h4>
                      <p className="text-sm text-slate-500 mt-0.5">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                    </div>
                  </div>
                  <div className="flex items-center text-green-600 text-sm font-medium">
                    <Icons.Check /> <span className="ml-1">Ready</span>
                  </div>
                </div>
                <div className="mt-6 flex gap-3 justify-end pt-4 border-t border-slate-100">
                  <Button variant="ghost" onClick={() => setFile(null)} disabled={uploading}>
                    Remove
                  </Button>
                  <Button onClick={handleUploadAndProcess} disabled={uploading}>
                    {uploading ? (startingExtraction ? 'Starting extraction...' : 'Uploading...') : 'Start Processing'}
                  </Button>
                </div>
              </Card>
            )}
            <div className="mt-8 flex justify-between items-center">
              <Button variant="ghost" onClick={() => setStep(2)} disabled={uploading}>
                <Icons.ChevronLeft className="w-4 h-4" /> Back
              </Button>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="max-w-2xl mx-auto">
            <div className="text-center mb-8">
              <h2 className="text-xl font-semibold mb-2">Processing Document</h2>
              <p className="text-slate-500 text-sm font-medium">{file?.name}</p>
            </div>

            <Card className="p-8 mb-6">
              <div className="mb-8">
                <div className="flex justify-between text-sm mb-2 font-medium">
                  <span className="text-blue-600">{job?.status === 'failed' ? 'Failed' : 'Processing...'}</span>
                  <span className="text-blue-900">{job?.progress ?? 0}%</span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all duration-300 ${job?.status === 'failed' ? 'bg-red-500' : 'bg-blue-600'}`}
                    style={{ width: `${job?.progress ?? 0}%` }}
                  />
                </div>
                <div className="text-xs text-slate-500 mt-2 text-center">
                  Page {job?.current_page ?? 0} of {job?.total_pages ?? 0}
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center text-green-600 text-sm">
                  <Icons.Check />
                  <span className="ml-3">Document uploaded</span>
                </div>
                {STAGE_LABELS.map((label, i) => (
                  <div
                    key={label}
                    className={`flex items-center text-sm ${
                      stageIndex > i || job?.status === 'completed'
                        ? 'text-green-600'
                        : stageIndex === i && job?.status === 'processing'
                          ? 'text-blue-600 font-medium'
                          : 'text-slate-400'
                    }`}
                  >
                    {stageIndex > i || job?.status === 'completed' ? (
                      <Icons.Check />
                    ) : stageIndex === i && job?.status === 'processing' ? (
                      <div className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin ml-0.5 mr-0.5" />
                    ) : (
                      <div className="w-1.5 h-1.5 bg-slate-300 rounded-full ml-1.5 mr-2" />
                    )}
                    <span className="ml-3">{label}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        ) : null}

        {step === 5 && job ? (
          <div className="max-w-5xl mx-auto pb-20">
            <div className="flex justify-between items-end mb-6">
              <div>
                <h2 className="text-2xl font-semibold">Extraction Results</h2>
                <p className="text-slate-500 mt-1">
                  Document processing complete. Data mapped to {selectedTemplate?.template_name ?? 'template'}.
                </p>
              </div>
              <Button onClick={() => navigate(`/projects/${projectId}`)}>
                View Structured Output <Icons.ArrowRight className="w-4 h-4" />
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-8">
              <Card className="p-5 border-l-4 border-l-blue-500">
                <div className="text-sm font-medium text-slate-500">Total Fields</div>
                <div className="text-3xl font-semibold mt-1">{fieldsTotal}</div>
              </Card>
              <Card className="p-5 border-l-4 border-l-green-500">
                <div className="text-sm font-medium text-slate-500">Extracted</div>
                <div className="text-3xl font-semibold mt-1 text-green-700">{fieldsWithValue}</div>
              </Card>
              <Card className="p-5 border-l-4 border-l-red-500">
                <div className="text-sm font-medium text-slate-500">Missing</div>
                <div className="text-3xl font-semibold mt-1 text-red-600">{fieldsMissing}</div>
              </Card>
            </div>

            <Card className="overflow-hidden">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Field</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Extracted Value</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Source</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-slate-200">
                  {(job.extracted_fields ?? []).map((f: any) => (
                    <tr key={f.field_id}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900">{f.field_label}</td>
                      <td className="px-6 py-4 text-sm text-slate-600 max-w-xs truncate">{f.value ?? 'No value extracted'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium">
                        {f.source_references[0]?.page_number ? `Page ${f.source_references[0].page_number}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  )
}