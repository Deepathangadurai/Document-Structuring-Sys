import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Icons } from './icons'

function NavItem({
  to,
  label,
  icon: Icon,
  active,
}: {
  to: string
  label: string
  icon: (props: { className?: string }) => React.ReactElement
  active: boolean
}) {
  return (
    <Link
      to={to}
      className={`w-full flex items-center px-4 py-2.5 mb-1 rounded-md text-sm font-medium transition-colors ${
        active ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      <Icon className={`w-5 h-5 mr-3 ${active ? 'text-blue-600' : 'text-slate-400'}`} />
      {label}
    </Link>
  )
}

function useBreadcrumb(pathname: string): { label: string; trail: string[] } {
  if (pathname === '/') return { label: 'Dashboard', trail: [] }
  if (pathname === '/projects') return { label: 'Projects', trail: [] }
  if (pathname === '/projects/new') return { label: 'New Project Setup', trail: ['Projects'] }
  if (pathname === '/templates') return { label: 'Templates', trail: [] }
  if (pathname.startsWith('/projects/')) return { label: 'Project Workspace', trail: ['Projects'] }
  return { label: '', trail: [] }
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const { label, trail } = useBreadcrumb(location.pathname)

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      <div className="w-64 bg-white border-r border-slate-200 flex flex-col z-20 shadow-sm">
        <div className="h-16 flex items-center px-6 border-b border-slate-200">
          <div className="w-6 h-6 bg-blue-600 rounded mr-3 flex items-center justify-center text-white font-bold text-xs">
            DS
          </div>
          <span className="font-bold text-slate-900 tracking-tight truncate">DocStructure Sys</span>
        </div>

        <div className="flex-1 overflow-y-auto py-4 px-3 scrollbar-hide">
          <NavItem to="/" label="Dashboard" icon={Icons.LayoutDashboard} active={location.pathname === '/'} />

          <div className="mt-6 mb-2 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">Management</div>
          <NavItem to="/projects" label="Projects" icon={Icons.Folder} active={location.pathname === '/projects'} />
          <NavItem
            to="/projects/new"
            label="Create Project"
            icon={Icons.FileText}
            active={location.pathname === '/projects/new'}
          />
          <NavItem to="/templates" label="Templates" icon={Icons.LayoutDashboard} active={location.pathname === '/templates'} />
        </div>

        <div className="p-4 border-t border-slate-200 bg-slate-50">
          <div className="flex items-center">
            <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold border border-indigo-200">
              D
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-slate-900">Deepa</p>
              <p className="text-xs text-slate-500">Document Engineer</p>
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
                className="pl-9 pr-4 py-1.5 bg-slate-100 border-transparent rounded-md text-sm focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all w-64"
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

        <main className="flex-1 overflow-hidden relative">{children}</main>
      </div>
    </div>
  )
}