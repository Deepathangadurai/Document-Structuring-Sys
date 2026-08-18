import React from 'react'

type BadgeType =
  | 'completed'
  | 'processing'
  | 'validation'
  | 'draft'
  | 'active'
  | 'high'
  | 'medium'
  | 'low'
  | 'pending'
  | 'failed'
  | 'verified'
  | 'missing'
  | 'review'
  | 'rejected'

const BADGE_STYLES: Record<BadgeType, string> = {
  completed: 'bg-green-100 text-green-800 border-green-200',
  processing: 'bg-blue-100 text-blue-800 border-blue-200',
  validation: 'bg-amber-100 text-amber-800 border-amber-200',
  draft: 'bg-slate-100 text-slate-800 border-slate-200',
  active: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  high: 'bg-green-50 text-green-700 border-green-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-red-50 text-red-700 border-red-200',
  pending: 'bg-slate-100 text-slate-600 border-slate-200',
  failed: 'bg-red-100 text-red-800 border-red-200',
  verified: 'bg-green-100 text-green-800 border-green-200',
  missing: 'bg-red-50 text-red-700 border-red-200',
  review: 'bg-amber-100 text-amber-800 border-amber-200',
  rejected: 'bg-slate-200 text-slate-500 border-slate-300 line-through',
}

export function Badge({ children, type, title }: { children: React.ReactNode; type: string; title?: string }) {
  const key = (type?.toLowerCase() as BadgeType) || 'draft'
  const style = BADGE_STYLES[key] || BADGE_STYLES.draft
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${style}`}
    >
      {children}
    </span>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export function Button({
  children,
  variant = 'primary',
  onClick,
  className = '',
  disabled = false,
  type = 'button',
}: {
  children: React.ReactNode
  variant?: ButtonVariant
  onClick?: () => void
  className?: string
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed'
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500 shadow-sm',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 focus:ring-blue-500 shadow-sm',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500 shadow-sm',
    ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  )
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-lg border border-slate-200 shadow-sm ${className}`}>{children}</div>
}