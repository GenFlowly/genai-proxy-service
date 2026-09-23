import React, { useState } from 'react'
import { useRunHitl } from '../../../../context/ConversationContext'

/**
 * Human-in-the-loop prompt for durable runs paused on an in-graph interrupt().
 * Rendered app-side (the response-card UI lives in the compiled component
 * library, so the polished in-card version is a follow-up there). Shows the
 * run's prompt + a reply box; submitting resumes the run via the resume endpoint.
 */
export const RunHitlBanner: React.FC = () => {
    const { awaitingInputs, submitRunReply } = useRunHitl()
    const [drafts, setDrafts] = useState<Record<string, string>>({})
    const entries = Object.entries(awaitingInputs)
    if (entries.length === 0) return null

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px' }}>
            {entries.map(([messageId, payload]) => {
                const prompt = (payload?.prompt as string) || 'The assistant needs your input to continue.'
                const draft = drafts[messageId] ?? ''
                const send = () => {
                    const text = draft.trim()
                    if (!text) return
                    submitRunReply(messageId, text)
                    setDrafts(prev => ({ ...prev, [messageId]: '' }))
                }
                return (
                    <div
                        key={messageId}
                        role="region"
                        aria-label="Assistant needs your input"
                        data-testid="run-hitl-prompt"
                        style={{
                            border: '1px solid var(--border-color, #d0d0d0)',
                            borderRadius: 8,
                            padding: 12,
                            background: 'var(--surface-2, #fafafa)',
                        }}
                    >
                        <div style={{ marginBottom: 8, fontWeight: 500 }}>{prompt}</div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <input
                                type="text"
                                value={draft}
                                placeholder="Type your reply…"
                                onChange={e => setDrafts(prev => ({ ...prev, [messageId]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') send() }}
                                style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-color, #d0d0d0)' }}
                            />
                            <button onClick={send} disabled={!draft.trim()} style={{ padding: '6px 14px', borderRadius: 6 }}>
                                Send
                            </button>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
