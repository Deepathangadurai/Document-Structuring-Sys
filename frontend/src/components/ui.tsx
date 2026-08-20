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

// Status colors follow the AmperePro Design System (DESIGN_SYSTEM.md §7)
const BADGE_STYLES: Record<BadgeType, string> = {
  completed: 'bg-success-light text-success border-success/20',
  processing: 'bg-info-light text-info border-info/20',
  validation: 'bg-warning-light text-warning border-warning/20',
  draft: 'bg-slate-100 text-slate-600 border-slate-200',
  active: 'bg-success-light text-success border-success/20',
  high: 'bg-success-light text-success border-success/20',
  medium: 'bg-warning-light text-warning border-warning/20',
  low: 'bg-danger-light text-danger border-danger/20',
  pending: 'bg-warning-light text-warning border-warning/20',
  failed: 'bg-danger-light text-danger border-danger/20',
  verified: 'bg-success-light text-success border-success/20',
  missing: 'bg-danger-light text-danger border-danger/20',
  review: 'bg-review-light text-review border-review/20',
  rejected: 'bg-danger-light text-danger border-danger/20 line-through',
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
  style,
}: {
  children: React.ReactNode
  variant?: ButtonVariant
  onClick?: () => void
  className?: string
  disabled?: boolean
  type?: 'button' | 'submit'
  style?: React.CSSProperties
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed'
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-brand text-white hover:bg-brand-dark focus:ring-brand',
    secondary: 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 focus:ring-brand',
    danger: 'bg-danger text-white hover:bg-danger/90 focus:ring-danger',
    ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={style}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm ${className}`}>{children}</div>
}