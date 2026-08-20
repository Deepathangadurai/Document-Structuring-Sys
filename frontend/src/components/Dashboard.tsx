import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card } from './ui'
import { Icons } from './icons'
import { getDashboardStats, listProjects } from '../services/api'
import type { DashboardStatsResponse, ProjectResponse } from '../types'

function projectStatusBadge(project: ProjectResponse): { label: string; type: string } {
  if (project.latest_job_status === 'completed') return { label: 'Completed', type: 'completed' }
  if (project.latest_job_status === 'processing') return { label: 'Processing', type: 'processing' }
  if (project.latest_job_status === 'failed') return { label: 'Failed', type: 'failed' }
  if (project.latest_job_status === 'pending') return { label: 'Pending', type: 'processing' }
  if (project.document_count > 0) return { label: 'Awaiting Extraction', type: 'validation' }
  return { label: 'Draft', type: 'draft' }
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diffMs = Date.now() - then
  const diffMinutes = Math.floor(diffMs / 60000)
  if (diffMinutes < 1) return 'Just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStatsResponse | null>(null)
  const [projects, setProjects] = useState<ProjectResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [statsResult, projectsResult] = await Promise.all([getDashboardStats(), listProjects()])
        if (!cancelled) {
          setStats(statsResult)
          setProjects(projectsResult)
        }
      } catch (err) {
        if (!cancelled) setError(`Could not load dashboard: ${(err as Error).message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="p-8 max-w-7xl mx-auto overflow-y-auto h-full pb-20">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 mt-1">Manage projects, templates and document extraction workflows.</p>
        </div>
        <Link to="/projects/new">
          <Button>
            <Icons.Plus className="w-4 h-4" /> Create Project
          </Button>
        </Link>
      </div>

      {error ? (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8">
        <Card className="p-5">
          <div className="text-sm font-medium text-slate-500 mb-1">Total Projects</div>
          <div className="text-3xl font-semibold text-slate-900">{loading ? '—' : stats?.total_projects ?? 0}</div>
          <div className="text-xs text-green-600 mt-2 font-medium">
            {loading ? '' : `+${stats?.projects_created_this_month ?? 0} this month`}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-sm font-medium text-slate-500 mb-1">Documents Processed</div>
          <div className="text-3xl font-semibold text-slate-900">{loading ? '—' : stats?.documents_processed ?? 0}</div>
          <div className="text-xs text-green-600 mt-2 font-medium">
            {loading ? '' : `+${stats?.documents_processed_this_week ?? 0} this week`}
          </div>
        </Card>
        <Card className="p-5 border-brand/20 bg-brand-light/40">
          <div className="text-sm font-medium text-brand mb-1">Extraction Accuracy</div>
          <div className="text-3xl font-semibold text-brand">
            {loading || stats?.extraction_accuracy == null ? '—' : `${stats.extraction_accuracy}%`}
          </div>
          <div className="text-xs text-brand mt-2 font-medium">Across validated fields</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm font-medium text-slate-500 mb-1">Pending Validation</div>
          <div className="text-3xl font-semibold text-amber-600">{loading ? '—' : stats?.pending_validation ?? 0}</div>
          <div className="text-xs text-amber-600 mt-2 font-medium">Requires review</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm font-medium text-slate-500 mb-1">Active Templates</div>
          <div className="text-3xl font-semibold text-slate-900">{loading ? '—' : stats?.active_templates ?? 0}</div>
          <div className="text-xs text-slate-500 mt-2 font-medium">Master specifications</div>
        </Card>
      </div>

      <h2 className="text-lg font-semibold text-slate-900 mb-4">Recent Projects</h2>
      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="p-8 text-sm text-slate-500 text-center">
            No projects yet.{' '}
            <Link to="/projects/new" className="text-brand hover:underline">
              Create your first project
            </Link>
            .
          </div>
        ) : (
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3">Project</th>
                <th className="px-6 py-3">Template</th>
                <th className="px-6 py-3 text-center">Docs</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Updated</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {projects.slice(0, 8).map((p) => {
                const status = projectStatusBadge(p)
                return (
                  <tr key={p.id} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-brand">
                      <Link to={`/projects/${p.id}`}>{p.project_name}</Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">
                      <div className="flex items-center">
                        <Icons.FileText className="w-4 h-4" /> <span className="ml-2">{p.template_name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600 text-center">{p.document_count}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge type={status.type}>{status.label}</Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">{timeAgo(p.updated_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}