import React, { useMemo, useState } from 'react'
import { Badge, Card } from './ui'
import { Icons } from './icons'
import type { StaticBlock } from '../types'

export interface StaticContentFormProps {
    blocks: StaticBlock[]
    activePage: number | null
    onChangeText: (blockId: string, text: string) => void
    onPromote: (block: StaticBlock) => void
}

export default function StaticContentForm({ blocks, activePage, onChangeText, onPromote }: StaticContentFormProps) {
    const [showAllPages, setShowAllPages] = useState(false)

    const visible = useMemo(() => {
        const filtered = showAllPages || activePage == null ? blocks : blocks.filter((b) => b.page_number === activePage)
        // Blank "fill in later" spots first - they're the ones most likely to
        // actually need a decision (edit the wording, or promote to a field).
        return [...filtered].sort((a, b) => Number(b.looks_like_blank_field) - Number(a.looks_like_blank_field))
    }, [blocks, activePage, showAllPages])

    return (
        <Card className="p-4">
            <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold text-sm">Static Content</h3>
                <Badge type="draft">{blocks.length}</Badge>
            </div>
            <p className="text-xs text-slate-500 mb-1">
                Fixed wording that's part of the master template itself - the same in every generated document. Edit it here
                to fix the master template's own text (not a per-project value).
            </p>
            {activePage != null ? (
                <button
                    type="button"
                    className="text-[11px] text-brand hover:underline mb-3"
                    onClick={() => setShowAllPages((v) => !v)}
                >
                    {showAllPages ? `Showing all pages - show only page ${activePage}` : `Showing page ${activePage} only - show all pages`}
                </button>
            ) : null}

            {visible.length === 0 ? (
                <p className="text-xs text-slate-400">No static content on this page.</p>
            ) : (
                <div className="space-y-3 max-h-[32rem] overflow-y-auto pr-1">
                    {visible.map((block) => {
                        const isTable = block.block_type === 'table'
                        return (
                            <div
                                key={block.block_id}
                                className={`rounded-md border p-3 ${block.looks_like_blank_field ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-slate-50/60'
                                    }`}
                            >
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                                        {block.block_type} &middot; page {block.page_number}
                                    </span>
                                    {block.looks_like_blank_field ? (
                                        <span className="text-[11px] text-amber-700 font-medium">Blank - possibly a field?</span>
                                    ) : null}
                                </div>

                                {isTable ? (
                                    <>
                                        <pre className="whitespace-pre-wrap text-xs bg-white border border-slate-200 rounded p-2 text-slate-600">
                                            {block.text}
                                        </pre>
                                        <p className="text-[11px] text-slate-400 mt-1">
                                            View only for now - editing a whole table's wording safely needs a cell-by-cell editor, coming
                                            separately, so its structure (rowspan/colspan/empty cells) can't be accidentally broken here.
                                        </p>
                                    </>
                                ) : (
                                    <textarea
                                        className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-brand focus:outline-none"
                                        rows={block.text.length > 60 ? 3 : block.looks_like_blank_field ? 2 : 1}
                                        placeholder={block.looks_like_blank_field ? '(blank line in the source document)' : ''}
                                        value={block.text}
                                        onChange={(e) => onChangeText(block.block_id, e.target.value)}
                                    />
                                )}

                                {!isTable ? (
                                    <button
                                        type="button"
                                        className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-brand hover:underline"
                                        onClick={() => onPromote(block)}
                                        title="This isn't fixed wording - it should be a per-project value instead"
                                    >
                                        <Icons.Plus className="w-3.5 h-3.5" />
                                        Mark as Dynamic Field instead
                                    </button>
                                ) : null}
                            </div>
                        )
                    })}
                </div>
            )}
        </Card>
    )
}