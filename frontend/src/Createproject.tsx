import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Card } from './components/ui'
import { Icons } from './components/icons'
import {
  createProject,
  detectSpecifications,
  getExtraction,
  startExtraction,
  uploadDocument,
} from './services/api'
import type { DetectedSpecificationResponse, ExtractionJobResponse } from './types'

type WizardStep = 1 | 2 | 3 | 4 | 5

const STEP_LABELS = ['Details', 'Upload', 'Detect & Match', 'Extraction', 'Results']

interface SpecJob {
  spec: DetectedSpecificationResponse
  job: ExtractionJobResponse | null
  error: string | null
}

function matchBadgeType(status: DetectedSpecificationResponse['match_status']): string {
  if (status === 'matched') return 'verified'
  if (status === 'review') return 'review'
  return 'missing'
}

function matchLabel(status: DetectedSpecificationResponse['match_status']): string {
  if (status === 'matched') return 'MATCH'
  if (status === 'review') return 'REVIEW'
  return 'NOT FOUND'
}

export default function CreateProject() {
  const navigate = useNavigate()

  const [step, setStep] = useState<WizardStep>(1)
  const [error, setError] = useState<string | null>(null)

  // Step 1 — project identity
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [projectId, setProjectId] = useState<number | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)

  // Step 2 — single source document
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [documentId, setDocumentId] = useState<number | null>(null)

  // Step 3 — detected specifications (matched against the 13 master
  // templates — 3 sample templates available today: specification_01/02/03)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [detected, setDetected] = useState<DetectedSpecificationResponse[]>([])
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set())

  // Step 4 — one extraction job per confirmed specification
  const [specJobs, setSpecJobs] = useState<SpecJob[]>([])
  const [launching, setLaunching] = useState(false)

  async function handleStep1Continue() {
    if (!projectName.trim()) return
    setError(null)
    setCreatingProject(true)
    try {
      const project = await createProject({
        project_name: projectName.trim(),
        project_code: projectCode.trim() || undefined,
      })
      setProjectId(project.id)
      setStep(2)
    } catch (err) {
      setError(`Could not create project: ${(err as Error).message}`)
    } finally {
      setCreatingProject(false)
    }
  }

  async function handleUploadAndDetect() {
    if (!file || !projectId) return
    setError(null)
    setUploading(true)
    setUploadProgress(0)
    try {
      // Use XHR so we can track real upload progress
      const document = await new Promise<import('./types').DocumentMetadataResponse>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api'
        xhr.open('POST', `${API_BASE}/projects/${projectId}/documents`)
        xhr.upload.addEventListener('progress', (ev) => {
          if (ev.lengthComputable) {
            setUploadProgress(Math.round((ev.loaded / ev.total) * 100))
          }
        })
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText) as import('./types').DocumentMetadataResponse) }
            catch { reject(new Error('Invalid server response')) }
          } else {
            try {
              const body = JSON.parse(xhr.responseText) as { detail?: string }
              reject(new Error(body.detail ?? xhr.statusText))
            } catch { reject(new Error(xhr.statusText)) }
          }
        })
        xhr.addEventListener('error', () => reject(new Error('Network error during upload')))
        const form = new FormData()
        form.append('file', file)
        xhr.send(form)
      })
      setUploadProgress(100)
      setDocumentId(document.id)
      setStep(3)
      await runDetection()
    } catch (err) {
      setError(`Could not upload document: ${(err as Error).message}`)
    } finally {
      setUploading(false)
    }
  }

  async function runDetection() {
    if (!projectId) return
    setDetecting(true)
    setDetectError(null)
    try {
      const results = await detectSpecifications(projectId)
      setDetected(results)
      setConfirmedIds(new Set(results.filter((r) => r.match_status !== 'not_found').map((r) => r.template_id)))
    } catch (err) {
      setDetectError(
        `Specification detection is not available yet: ${(err as Error).message}. ` +
          `This calls a new backend endpoint (POST /projects/{id}/detect-specifications) that still needs to be implemented against Docling + the master templates.`,
      )
    } finally {
      setDetecting(false)
    }
  }

  function toggleConfirmed(templateId: string) {
    setConfirmedIds((prev) => {
      const next = new Set(prev)
      if (next.has(templateId)) next.delete(templateId)
      else next.add(templateId)
      return next
    })
  }

  async function handleStartExtraction() {
    if (!documentId) return
    const chosen = detected.filter((d) => confirmedIds.has(d.template_id))
    if (chosen.length === 0) return
    setError(null)
    setLaunching(true)
    setStep(4)
    const initial: SpecJob[] = chosen.map((spec) => ({ spec, job: null, error: null }))
    setSpecJobs(initial)
    try {
      const results = await Promise.all(
        chosen.map(async (spec) => {
          try {
            const job = await startExtraction(projectId!, { document_id: documentId, template_id: spec.template_id })
            return { spec, job, error: null } as SpecJob
          } catch (err) {
            return { spec, job: null, error: (err as Error).message } as SpecJob
          }
        }),
      )
      setSpecJobs(results)
    } finally {
      setLaunching(false)
    }
  }

  // Poll every in-flight job until all of them finish (or fail).
  useEffect(() => {
    if (step !== 4) return
    const hasActiveJob = specJobs.some((sj) => sj.job && sj.job.status !== 'completed' && sj.job.status !== 'failed')
    if (!hasActiveJob) {
      if (specJobs.length > 0 && specJobs.every((sj) => sj.job)) setStep(5)
      return
    }
    const timer = window.setInterval(async () => {
      const updated = await Promise.all(
        specJobs.map(async (sj) => {
          if (!sj.job || sj.job.status === 'completed' || sj.job.status === 'failed') return sj
          try {
            const job = await getExtraction(sj.job.id)
            return { ...sj, job }
          } catch (err) {
            return { ...sj, error: (err as Error).message }
          }
        }),
      )
      setSpecJobs(updated)
    }, 2000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, specJobs])

  return (
    <div className="h-full flex flex-col">
      <div className="px-8 py-4 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between max-w-6xl mx-auto">
          {[1, 2, 3, 4, 5].map((s) => (
            <React.Fragment key={s}>
              <div className="flex items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium border-2 ${
                    step === s
                      ? 'border-brand text-brand bg-brand-light'
                      : step > s
                        ? 'border-brand bg-brand text-white'
                        : 'border-slate-300 text-slate-400 bg-white'
                  }`}
                >
                  {step > s ? <Icons.Check className="w-4 h-4" /> : s}
                </div>
                <span className={`ml-3 text-sm font-medium ${step >= s ? 'text-slate-900' : 'text-slate-400'}`}>
                  {STEP_LABELS[s - 1]}
                </span>
              </div>
              {s < 5 && <div className={`flex-1 mx-4 h-0.5 ${step > s ? 'bg-brand' : 'bg-slate-200'}`} />}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8 bg-slate-50">
        {error ? (
          <div className="max-w-2xl mx-auto mb-6 p-4 bg-danger-light border border-danger/20 rounded-lg text-sm text-danger">
            {error}
          </div>
        ) : null}

        {/* Step 1 — Project ID + name */}
        {step === 1 ? (
          <div className="max-w-2xl mx-auto">
            <h2 className="text-xl font-semibold mb-1">Project Details</h2>
            <p className="text-slate-500 text-sm mb-6">
              Every project starts with an ID and one source document — specifications are detected automatically
              from it, you don't pick a template up front.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Project ID</label>
                <input
                  type="text"
                  value={projectCode}
                  onChange={(e) => setProjectCode(e.target.value)}
                  placeholder="e.g. PRJ-2026-014 (leave blank to auto-assign)"
                  className="w-full rounded-lg border border-slate-200 p-2.5 text-sm focus:ring-2 focus:ring-brand/20 focus:border-brand"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Project Name <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="e.g. Airport Terminal Expansion"
                  className="w-full rounded-lg border border-slate-200 p-2.5 text-sm focus:ring-2 focus:ring-brand/20 focus:border-brand"
                />
              </div>
            </div>
            <div className="mt-8 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => navigate('/')}>
                Cancel
              </Button>
              <Button onClick={handleStep1Continue} disabled={!projectName.trim() || creatingProject}>
                {creatingProject ? 'Creating project...' : 'Save & Continue'}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Step 2 — single source document upload */}
        {step === 2 ? (
          <div className="max-w-3xl mx-auto">
            <div className="mb-6 text-center">
              <h2 className="text-xl font-semibold">Upload Source Document</h2>
              <p className="text-slate-500 text-sm mt-1">
                Upload the one document for this project. We'll scan it page-by-page and detect which
                specifications it contains.
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
                    <div className="bg-brand-light p-3 rounded-lg mr-4">
                      <Icons.File />
                    </div>
                    <div>
                      <h4 className="font-medium text-slate-900">{file.name}</h4>
                      <p className="text-sm text-slate-500 mt-0.5">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                    </div>
                  </div>
                  {uploading ? (
                    <span className="text-sm font-semibold text-brand">{uploadProgress}%</span>
                  ) : (
                    <div className="flex items-center text-success text-sm font-medium">
                      <Icons.Check /> <span className="ml-1">Ready</span>
                    </div>
                  )}
                </div>

                {/* Upload progress bar */}
                {uploading && (
                  <div className="mt-4">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs text-slate-500">Uploading document…</span>
                      <span className="text-xs font-semibold text-brand">{uploadProgress}%</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="h-2.5 rounded-full bg-brand transition-all duration-200"
                        style={{ width: `${Math.max(1, uploadProgress)}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="mt-6 flex gap-3 justify-end pt-4 border-t border-slate-100">
                  <Button variant="ghost" onClick={() => setFile(null)} disabled={uploading}>
                    Remove
                  </Button>
                  <Button onClick={handleUploadAndDetect} disabled={uploading}>
                    {uploading ? `Uploading… ${uploadProgress}%` : 'Upload & Detect Specifications'}
                  </Button>
                </div>
              </Card>
            )}
            <div className="mt-8 flex justify-between items-center">
              <Button variant="ghost" onClick={() => setStep(1)} disabled={uploading}>
                <Icons.ChevronLeft className="w-4 h-4" /> Back
              </Button>
            </div>
          </div>
        ) : null}

        {/* Step 3 — detected specifications, matched to master templates */}
        {step === 3 ? (
          <div className="max-w-5xl mx-auto">
            <div className="mb-6">
              <h2 className="text-xl font-semibold">Detected Specifications</h2>
              <p className="text-slate-500 text-sm mt-1">
                Every page of <span className="font-medium">{file?.name}</span> was checked against the master
                templates. Confirm which detected specifications to generate — each one becomes its own output file.
              </p>
            </div>

            <div className="bg-warning-light border border-warning/20 rounded-lg p-4 mb-6 flex items-start">
              <div className="text-warning mt-0.5 mr-3">
                <Icons.Lock />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-900">MASTER TEMPLATE PROTECTION</h4>
                <p className="text-sm text-slate-700 mt-1">
                  Matched templates define the final structured output and are never modified. Only dynamic values
                  extracted from your document are populated into a copy of each matched template.
                </p>
              </div>
            </div>

            {detecting ? (
              <Card className="p-10 text-center">
                <div className="w-6 h-6 mx-auto rounded-full border-2 border-brand border-t-transparent animate-spin mb-3" />
                <p className="text-sm text-slate-500">Scanning document pages and matching specifications…</p>
              </Card>
            ) : detectError ? (
              <Card className="p-6">
                <div className="text-sm text-danger mb-4">{detectError}</div>
                <Button variant="secondary" onClick={() => void runDetection()}>
                  Retry Detection
                </Button>
              </Card>
            ) : (
              <div className="space-y-3">
                {detected.map((d) => {
                  const isConfirmed = confirmedIds.has(d.template_id)
                  const isFound = d.match_status !== 'not_found'
                  return (
                    <Card
                      key={d.template_id}
                      className={`p-5 flex items-center justify-between transition-all ${
                        isConfirmed ? 'ring-2 ring-brand border-brand' : ''
                      } ${!isFound ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-center gap-4">
                        <input
                          type="checkbox"
                          disabled={!isFound}
                          checked={isConfirmed}
                          onChange={() => toggleConfirmed(d.template_id)}
                          className="w-4 h-4 accent-[#1A3A6B]"
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-500 bg-slate-100 px-2 py-1 rounded">
                              {d.template_id}
                            </span>
                            <Badge type={matchBadgeType(d.match_status)}>{matchLabel(d.match_status)}</Badge>
                          </div>
                          <h3 className="text-base font-semibold text-slate-900 mt-1.5">{d.template_name}</h3>
                          {d.specification_number ? (
                            <p className="text-xs text-slate-500 mt-0.5">{d.specification_number}</p>
                          ) : null}
                          {d.matched_pages.length > 0 ? (
                            <p className="text-xs text-slate-400 mt-1">
                              Found on page{d.matched_pages.length > 1 ? 's' : ''} {d.matched_pages.join(', ')}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-semibold text-slate-900">
                          {Math.round(d.match_confidence * 100)}%
                        </div>
                        <div className="text-xs text-slate-400">confidence</div>
                      </div>
                    </Card>
                  )
                })}
                {detected.length === 0 ? (
                  <Card className="p-8 text-center text-sm text-slate-500">
                    No specifications were detected in this document.
                  </Card>
                ) : null}
              </div>
            )}

            <div className="mt-8 flex justify-between items-center">
              <Button variant="ghost" onClick={() => setStep(2)}>
                <Icons.ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button onClick={handleStartExtraction} disabled={confirmedIds.size === 0 || detecting || launching}>
                {launching
                  ? 'Starting extraction...'
                  : `Extract ${confirmedIds.size} Specification${confirmedIds.size === 1 ? '' : 's'}`}{' '}
                <Icons.ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ) : null}

        {/* Step 4 — one extraction job running per confirmed specification */}
        {step === 4 ? (
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="text-center mb-4">
              <h2 className="text-xl font-semibold mb-2">Extracting Dynamic Values</h2>
              <p className="text-slate-500 text-sm">
                Deterministic rules first, then Qdrant retrieval, then Qwen/Ollama for anything still missing.
              </p>
            </div>
            {specJobs.map((sj) => (
              <Card key={sj.spec.template_id} className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{sj.spec.template_name}</div>
                    <div className="text-xs text-slate-500">{sj.spec.template_id}</div>
                  </div>
                  <Badge type={sj.error ? 'failed' : sj.job?.status ?? 'pending'}>
                    {sj.error ? 'failed' : sj.job?.status ?? 'queued'}
                  </Badge>
                </div>
                {sj.error ? (
                  <p className="text-xs text-danger">{sj.error}</p>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs text-slate-500">
                        Page {sj.job?.current_page ?? 0} of {sj.job?.total_pages ?? 0}
                      </span>
                      <span className="text-xs font-semibold text-brand">
                        {Math.max(sj.job?.status === 'completed' ? 100 : 0, sj.job?.progress ?? 0)}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="h-2.5 rounded-full bg-brand transition-all duration-500"
                        style={{
                          width: `${Math.max(
                            sj.job?.status === 'completed' ? 100 : 1,
                            sj.job?.progress ?? 1,
                          )}%`,
                        }}
                      />
                    </div>
                  </>
                )}
              </Card>
            ))}
          </div>
        ) : null}

        {/* Step 5 — summary, hand off to the per-specification workspace */}
        {step === 5 ? (
          <div className="max-w-5xl mx-auto pb-20">
            <div className="flex justify-between items-end mb-6">
              <div>
                <h2 className="text-2xl font-semibold">Extraction Complete</h2>
                <p className="text-slate-500 mt-1">
                  {specJobs.length} specification{specJobs.length === 1 ? '' : 's'} processed from {file?.name}.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button className="bg-[#1A3A6B] hover:bg-[#12294d] text-white shadow-sm flex items-center gap-2" onClick={() => navigate(`/projects/${projectId}`)}>
                  Open Project Workspace <Icons.ArrowRight className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {specJobs.map((sj) => {
                const job = sj.job
                const total = job?.extracted_fields?.length ?? 0
                const filled = job?.extracted_fields?.filter((f) => f.value != null && f.value !== '').length ?? 0
                return (
                  <Card key={sj.spec.template_id} className="p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold text-slate-900">{sj.spec.template_name}</h3>
                      <Badge type={job?.status ?? 'pending'}>{job?.status ?? 'pending'}</Badge>
                    </div>
                    <div className="flex gap-6 text-sm text-slate-600">
                      <div>
                        <div className="text-xl font-semibold text-slate-900">{total}</div>
                        <div className="text-xs text-slate-400">total fields</div>
                      </div>
                      <div>
                        <div className="text-xl font-semibold text-success">{filled}</div>
                        <div className="text-xs text-slate-400">extracted</div>
                      </div>
                      <div>
                        <div className="text-xl font-semibold text-danger">{total - filled}</div>
                        <div className="text-xs text-slate-400">missing</div>
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}