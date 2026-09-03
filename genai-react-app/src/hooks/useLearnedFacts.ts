import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { LearnedFact } from '../models/conversation.models'
import { getLearnedFacts, deleteMemoryFact } from '../services/learnedFactsService'

/** How often to ask whether memory extraction finished for a fresh response. */
export const LEARNED_FACTS_POLL_INTERVAL_MS = 4000
/** Give up polling after this long — extraction that slow counts as "no new facts". */
export const LEARNED_FACTS_POLL_TIMEOUT_MS = 60000

export interface LearnedFactsState {
    /** `pending` while extraction is still running for a fresh response */
    status: 'pending' | 'done'
    facts: LearnedFact[]
    /**
     * Delete one fact from memory and drop it from `facts`. A backend 404
     * (already deleted elsewhere) also counts as success. Throws on real
     * failures, leaving the list unchanged.
     */
    removeFact: (memoryId: string) => Promise<void>
}

/**
 * Per-message learned-facts state for the response footer.
 *
 * - Historical messages (loaded via the conversation GET) carry their facts in
 *   `initial` (array = done, null = outcome unknown) — rendered directly,
 *   never polled.
 * - A response generated in this session (`isFreshResponse`) has no facts yet:
 *   extraction runs asynchronously server-side, so this polls the
 *   learned-facts endpoint every {@link LEARNED_FACTS_POLL_INTERVAL_MS} until
 *   it reports `done` or {@link LEARNED_FACTS_POLL_TIMEOUT_MS} passes
 *   (timeout ⇒ done with no facts). Polling stops on unmount and whenever the
 *   conversation/message identity changes.
 */
export function useLearnedFacts(
    conversationId: string,
    messageId: string,
    initial: LearnedFact[] | null | undefined,
    isFreshResponse: boolean
): LearnedFactsState {
    const { getAccessTokenSilently } = useAuth()

    const hasInitialFacts = Array.isArray(initial)
    const shouldPoll = isFreshResponse && !hasInitialFacts && !!conversationId && !!messageId

    const [facts, setFacts] = useState<LearnedFact[]>(hasInitialFacts ? initial : [])
    const [status, setStatus] = useState<'pending' | 'done'>(shouldPoll ? 'pending' : 'done')

    // Keep the auth getter out of the poll effect's deps — a re-render must not
    // restart the poll loop
    const getTokenRef = useRef(getAccessTokenSilently)
    getTokenRef.current = getAccessTokenSilently

    useEffect(() => {
        if (!shouldPoll) return

        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const startedAt = Date.now()

        const poll = async () => {
            try {
                const token = await getTokenRef.current()
                const result = await getLearnedFacts(token, conversationId, messageId)
                if (cancelled) return
                if (result.status === 'done') {
                    setFacts(result.facts)
                    setStatus('done')
                    return
                }
            } catch (e) {
                if (cancelled) return
                // Transient failure — treat like "still pending" and retry
                console.warn('Failed to fetch learned facts, will retry', e)
            }
            if (Date.now() - startedAt >= LEARNED_FACTS_POLL_TIMEOUT_MS) {
                // Extraction took too long — settle on the expected common case
                setStatus('done')
                return
            }
            timer = setTimeout(poll, LEARNED_FACTS_POLL_INTERVAL_MS)
        }

        poll()

        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
        }
    }, [shouldPoll, conversationId, messageId])

    const removeFact = useCallback(async (memoryId: string) => {
        const token = await getTokenRef.current()
        await deleteMemoryFact(token, memoryId)
        setFacts(prev => prev.filter(f => f.memoryId !== memoryId))
    }, [])

    return { status, facts, removeFact }
}
