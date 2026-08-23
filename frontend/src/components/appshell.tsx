import React, { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Icons } from './icons'
import { listPendingTemplates } from '../services/api'

function NavItem({
  to,
  label,
  icon: Icon,
  active,
  badge,
}: {
  to: string
  label: string
  icon: (props: { className?: string }) => React.ReactElement
  active: boolean
  badge?: number
}) {
  return (
    <Link
      to={to}
      className={`w-full flex items-center gap-2.5 px-3 py-2 mb-1 rounded-lg text-sm font-medium transition-all ${active ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
        }`}
    >
      <Icon className="w-5 h-5" />
      <span className="flex-1">{label}</span>
      {badge ? (
        <span className="ml-auto text-xs font-semibold bg-amber-400 text-slate-900 rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
          {badge}
        </span>
      ) : null}
    </Link>
  )
}

function useBreadcrumb(pathname: string): { label: string; trail: string[] } {
  if (pathname === '/') return { label: 'Dashboard', trail: [] }
  if (pathname === '/projects') return { label: 'Projects', trail: [] }
  if (pathname === '/projects/new') return { label: 'New Project Setup', trail: ['Projects'] }
  if (pathname === '/templates') return { label: 'Templates', trail: [] }
  if (pathname === '/templates/pending') return { label: 'Pending Review', trail: ['Templates'] }
  if (pathname.startsWith('/templates/pending/')) return { label: 'Review Template', trail: ['Templates'] }
  if (pathname.startsWith('/projects/')) return { label: 'Project Workspace', trail: ['Projects'] }
  return { label: '', trail: [] }
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const { label, trail } = useBreadcrumb(location.pathname)

  // Newly-synced/uploaded templates sit in "pending" until a human reviews
  // and approves them (see template_service.sync_templates) - they never
  // show up on the main Templates page or in project creation until then.
  // Previously the ONLY hint this queue existed was a small text link on
  // the Templates page itself, so templates could sit unreviewed
  // indefinitely without anyone noticing. Surface the count here, on every
  // page, so it's impossible to miss.
  const [pendingCount, setPendingCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const pending = await listPendingTemplates()
        if (!cancelled) setPendingCount(pending.length)
      } catch {
        // Non-critical for shell chrome - nav still works without the badge.
      }
    }
    void poll()
    const timer = window.setInterval(poll, 10000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      <div className="w-56 flex flex-col z-20 shadow-sm" style={{ background: '#1A3A6B' }}>
        <div className="h-16 flex items-center px-5 border-b border-white/10">
          <div className="w-7 h-7 rounded mr-2.5 flex items-center justify-center text-white font-bold text-xs" style={{ background: '#F97316' }}>
            DS
          </div>
          <span className="font-bold text-white tracking-tight truncate text-sm">DocStructure Sys</span>
        </div>

        <div className="flex-1 overflow-y-auto py-4 px-3 scrollbar-hide">
          <NavItem to="/" label="Dashboard" icon={Icons.LayoutDashboard} active={location.pathname === '/'} />

          <div className="mt-6 mb-2 px-3 text-xs font-semibold text-white/40 uppercase tracking-wider">Management</div>
          <NavItem to="/projects" label="Projects" icon={Icons.Folder} active={location.pathname === '/projects'} />
          <NavItem
            to="/projects/new"
            label="Create Project"
            icon={Icons.FileText}
            active={location.pathname === '/projects/new'}
          />
          <NavItem to="/templates" label="Templates" icon={Icons.LayoutDashboard} active={location.pathname === '/templates'} />
          <NavItem
            to="/templates/pending"
            label="Pending Review"
            icon={Icons.FileText}
            active={location.pathname.startsWith('/templates/pending')}
            badge={pendingCount}
          />
        </div>

        <div className="p-4 border-t border-white/10">
          <div className="flex items-center">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold" style={{ background: '#F97316' }}>
              D
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-white">Deepa</p>
              <p className="text-xs text-white/50">Document Engineer</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden bg-slate-50 relative">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 z-10 shadow-sm">
          <div className="flex items-center text-sm">
            <Link to="/" className="text-slate-400 hover:text-slate-600">
              {trail.length > 0 ? trail[0] : label}
            </Link>
            {trail.length > 0 ? (
              <>
                <Icons.ChevronRight className="w-4 h-4 text-slate-400 mx-2" />
                <span className="font-medium text-slate-900">{label}</span>
              </>
            ) : null}
          </div>

          <div className="flex items-center space-x-6 text-slate-500">
            <div className="relative">
              <Icons.Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search..."
                className="pl-9 pr-4 py-1.5 bg-slate-100 border-transparent rounded-md text-sm focus:bg-white focus:border-brand focus:ring-1 focus:ring-brand/20 transition-all w-64"
              />
            </div>
            <button className="hover:text-slate-900 relative">
              <Icons.Bell />
            </button>
            <button className="hover:text-slate-900">
              <Icons.Help />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto relative">{children}</main>
      </div>
    </div>
  )
}