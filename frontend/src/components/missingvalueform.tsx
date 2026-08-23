import React, { useMemo, useState } from 'react'
import { Badge, Button, Card } from './ui'
import { Icons } from './icons'
import type { ExtractedFieldResponse, FieldVerificationResponse, VerificationStatus } from '../types'

export interface MissingValuesFormProps {
    /** All extracted fields for the selected job, across every page - not
     * just the ones that happen to have a matching placeholder span on the
     * currently rendered page. This is what makes a NOT_FOUND field reachable
     * at all: if extraction never located a spot for it in the output, it
     * will never show up in the page-bound sidebar list. */
    fields: ExtractedFieldResponse[]
    verifyByFieldId: Record<string, FieldVerificationResponse>
    busyFieldId: string | null
    onApprove: (field: ExtractedFieldResponse, value: string) => Promise<void>
    onSaveForReview: (field: ExtractedFieldResponse, value: string) => Promise<void>
    onReject: (field: ExtractedFieldResponse) => Promise<void>
    onJumpToPage?: (pageNumber: number) => void
}

function verifyBadgeType(status?: VerificationStatus | null): string {
    if (status === 'match') return 'verified'
    if (status === 'mismatch') return 'rejected'
    if (status === 'not_found') return 'missing'
    if (status === 'review') return 'review'
    return 'missing'
}

function verifyLabel(status?: VerificationStatus | null): string {
    if (status === 'match') return 'MATCH'
    if (status === 'mismatch') return 'MISMATCH'
    if (status === 'review') return 'REVIEW'
    return 'NOT FOUND'
}

// A field "needs attention" here if verification flagged it as anything
// other than a clean match, OR - even before Verify has been run - it
// simply has no value yet. This second condition is what guarantees a
// NOT_FOUND field is never invisible: it shows up here the moment
// extraction finishes, whether or not the user has clicked "Run
// Verification" yet.
function needsAttention(field: ExtractedFieldResponse, verdict?: FieldVerificationResponse): boolean {
    if (verdict && verdict.status !== 'match') return true
    if (!verdict && !(field.value ?? '').trim()) return true
    return false
}

function priority(field: ExtractedFieldResponse, verdict?: FieldVerificationResponse): number {
    const required = verdict?.required ?? false
    const status = verdict?.status ?? (!(field.value ?? '').trim() ? 'not_found' : 'match')
    if (status === 'not_found' && required) return 0
    if (status === 'not_found') return 1
    if (status === 'mismatch') return 2
    if (status === 'review') return 3
    return 4
}

export default function MissingValuesForm({
    fields,
    verifyByFieldId,
    busyFieldId,
    onApprove,
    onSaveForReview,
    onReject,
    onJumpToPage,
}: MissingValuesFormProps) {
    const [drafts, setDrafts] = useState<{ [fieldId: string]: string }>({})

    const flagged = useMemo(() => {
        return fields
            .map((field) => ({ field, verdict: verifyByFieldId[field.field_id] }))
            .filter(({ field, verdict }) => needsAttention(field, verdict))
            .sort((a, b) => priority(a.field, a.verdict) - priority(b.field, b.verdict))
    }, [fields, verifyByFieldId])

    if (flagged.length === 0) {
        return (
            <Card className="p-4">
                <h3 className="font-semibold mb-1 text-sm">Needs Your Input</h3>
                <p className="text-xs text-slate-500">
                    Nothing flagged. Every extracted value either matches what the template requires or hasn&apos;t been
                    checked yet — run verification to confirm.
                </p>
            </Card>
        )
    }

    const requiredMissing = flagged.filter(
        ({ verdict }) => (verdict?.required ?? false) && (verdict?.status ?? 'not_found') === 'not_found',
    ).length

    return (
        <Card className="p-4 border-red-200">
            <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold text-sm">Needs Your Input</h3>
                <Badge type="missing">{flagged.length}</Badge>
            </div>
            <p className="text-xs text-slate-500 mb-3">
                {requiredMissing > 0
                    ? `${requiredMissing} required value${requiredMissing === 1 ? '' : 's'} could not be found in the source document. Type them in below — this is the only place to fix a value that has nowhere to go in the rendered page.`
                    : 'These values need a look before this specification can be generated.'}
            </p>

            <div className="space-y-3 max-h-[32rem] overflow-y-auto pr-1">
                {flagged.map(({ field, verdict }) => {
                    const draft = drafts[field.field_id] ?? field.value ?? ''
                    const isDirty = draft !== (field.value ?? '')
                    const isBusy = busyFieldId === field.field_id
                    const required = verdict?.required ?? false
                    const firstRef = field.source_references?.[0]
                    const helpText = verdict?.reason || verdict?.expected_hint

                    return (
                        <div
                            key={field.field_id}
                            className={`rounded-md border p-3 ${verdict?.status === 'not_found' || !verdict
                                    ? 'border-red-200 bg-red-50/40'
                                    : 'border-amber-200 bg-amber-50/40'
                                }`}
                        >
                            <div className="flex items-start justify-between gap-2">
                                <label className="text-xs font-semibold text-slate-800">
                                    {field.field_label}
                                    {required ? <span className="text-red-600"> *</span> : null}
                                </label>
                                <Badge type={verifyBadgeType(verdict?.status)}>{verifyLabel(verdict?.status)}</Badge>
                            </div>

                            {helpText ? <p className="text-[11px] text-slate-500 mt-0.5 mb-1.5">{helpText}</p> : null}

                            <textarea
                                className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-brand focus:outline-none"
                                rows={draft.length > 60 ? 3 : 1}
                                placeholder="Not found in source document — enter the value manually"
                                value={draft}
                                disabled={isBusy}
                                onChange={(e) => setDrafts((prev) => ({ ...prev, [field.field_id]: e.target.value }))}
                            />

                            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                                {firstRef?.page_number ? (
                                    <button
                                        type="button"
                                        className="text-[11px] text-brand hover:underline"
                                        onClick={() => onJumpToPage?.(firstRef.page_number as number)}
                                    >
                                        Source: page {firstRef.page_number}
                                        {firstRef.confidence != null ? ` · ${Math.round(firstRef.confidence * 100)}%` : ''}
                                    </button>
                                ) : (
                                    <span className="text-[11px] text-slate-400">No source location found</span>
                                )}

                                <div className="flex-1" />

                                <button
                                    type="button"
                                    disabled={isBusy}
                                    className="text-slate-500 hover:text-slate-700 disabled:opacity-30 text-[11px] font-medium"
                                    onClick={() => void onSaveForReview(field, draft)}
                                    title="Save this value, flagged for a follow-up look"
                                >
                                    Save
                                </button>
                                <button
                                    type="button"
                                    disabled={isBusy || (!draft.trim() && !isDirty)}
                                    className="text-green-600 hover:text-green-700 disabled:opacity-30"
                                    onClick={() => void onApprove(field, draft)}
                                    title="Approve this value"
                                >
                                    <Icons.Check className="w-4 h-4" />
                                </button>
                                <button
                                    type="button"
                                    disabled={isBusy}
                                    className="text-red-600 hover:text-red-700 disabled:opacity-40"
                                    onClick={() => void onReject(field)}
                                    title="Reject — leave this value blank in the output"
                                >
                                    <Icons.X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    )
                })}
            </div>
        </Card>
    )
}