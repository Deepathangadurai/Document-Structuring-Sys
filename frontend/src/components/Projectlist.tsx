import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card } from '../components/ui'
import { Icons } from '../components/icons'
import { listProjects } from '../services/api'
import type { ProjectResponse } from '../types'

function projectStatusBadge(project: ProjectResponse): { label: string; type: string } {
  if (project.latest_job_status === 'completed') return { label: 'Completed', type: 'completed' }
  if (project.latest_job_status === 'processing') return { label: 'Processing', type: 'processing' }
  if (project.latest_job_status === 'failed') return { label: 'Failed', type: 'failed' }
  if (project.latest_job_status === 'pending') return { label: 'Pending', type: 'processing' }
  if (project.document_count > 0) return { label: 'Awaiting Extraction', type: 'validation' }
  return { label: 'Draft', type: 'draft' }
}

export default function ProjectsList() {
  const [projects, setProjects] = useState<ProjectResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await listProjects()
        if (!cancelled) setProjects(result)
      } catch (err) {
        if (!cancelled) setError(`Could not load projects: ${(err as Error).message}`)
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
          <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
          <p className="text-slate-500 mt-1">Every project created from a master template.</p>
        </div>
        <Link to="/projects/new">
          <Button>
            <Icons.Plus className="w-4 h-4" /> Create Project
          </Button>
        </Link>
      </div>

      {error ? <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div> : null}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="p-8 text-sm text-slate-500 text-center">
            No projects yet.{' '}
            <Link to="/projects/new" className="text-blue-600 hover:underline">
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
                <th className="px-6 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {projects.map((p) => {
                const status = projectStatusBadge(p)
                return (
                  <tr key={p.id} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600">
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
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      {new Date(p.created_at).toLocaleDateString()}
                    </td>
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