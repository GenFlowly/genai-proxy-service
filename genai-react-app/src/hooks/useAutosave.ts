import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface AutosaveSaveOptions {
    encode: boolean
    keepalive: boolean
}

interface UseAutosaveOptions {
    content: string
    save: (content: string, options: AutosaveSaveOptions) => Promise<void>
    // Autosave only runs while enabled (e.g. KV notes need a non-empty key)
    enabled?: boolean
    debounceMs?: number
    maxWaitMs?: number
    encodeIdleMs?: number
    retryMs?: number
}

interface UseAutosaveResult {
    status: SaveStatus
    lastSavedAt: Date | null
    // Save immediately, cancelling pending timers (blur, tab close)
    flush: (options?: Partial<AutosaveSaveOptions>) => void
    // Rebaseline on the given content without saving (e.g. a note was loaded
    // into the editor); pending work for the previous content is dropped
    reset: (content: string) => void
}

// Google-Docs-style autosave: debounced DynamoDB-only saves while typing
// (encode=false), and a full save with encoding once typing goes idle, on
// flush, or on tab close. Every save sends the complete content, so
// intermediate states can be dropped and the latest write always wins.
export function useAutosave({
    content,
    save,
    enabled = true,
    debounceMs = 1500,
    maxWaitMs = 8000,
    encodeIdleMs = 10000,
    retryMs = 5000,
}: UseAutosaveOptions): UseAutosaveResult {
    const [status, setStatus] = useState<SaveStatus>('idle')
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

    const contentRef = useRef(content)
    const saveRef = useRef(save)
    const enabledRef = useRef(enabled)
    const lastSavedContentRef = useRef(content)
    const lastEncodedContentRef = useRef(content)
    const savingRef = useRef(false)
    const pendingRef = useRef<{ encode: boolean } | null>(null)
    // Bumped by reset() so an in-flight save can't rebaseline stale content
    const generationRef = useRef(0)

    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const maxWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const encodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    saveRef.current = save
    enabledRef.current = enabled

    const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
        if (ref.current !== null) {
            clearTimeout(ref.current)
            ref.current = null
        }
    }

    const performSaveRef = useRef<(options: AutosaveSaveOptions) => void>(() => {})
    performSaveRef.current = (options: AutosaveSaveOptions) => {
        if (!enabledRef.current) return

        const snapshot = contentRef.current
        const alreadySaved = snapshot === lastSavedContentRef.current
        const alreadyEncoded = snapshot === lastEncodedContentRef.current
        if (alreadySaved && (!options.encode || alreadyEncoded)) return

        if (savingRef.current) {
            // One trailing save is enough: it will pick up the latest content
            pendingRef.current = { encode: (pendingRef.current?.encode ?? false) || options.encode }
            return
        }

        const generation = generationRef.current
        savingRef.current = true
        setStatus('saving')
        saveRef.current(snapshot, options)
            .then(() => {
                if (generationRef.current === generation) {
                    lastSavedContentRef.current = snapshot
                    if (options.encode) {
                        lastEncodedContentRef.current = snapshot
                    }
                    setStatus('saved')
                    setLastSavedAt(new Date())
                }
            })
            .catch(() => {
                if (generationRef.current === generation) {
                    setStatus('error')
                    clearTimer(retryTimerRef)
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = null
                        performSaveRef.current({ encode: options.encode, keepalive: false })
                    }, retryMs)
                }
            })
            .finally(() => {
                savingRef.current = false
                if (generationRef.current === generation && pendingRef.current) {
                    const pending = pendingRef.current
                    pendingRef.current = null
                    performSaveRef.current({ encode: pending.encode, keepalive: false })
                }
            })
    }

    const flush = useCallback((options: Partial<AutosaveSaveOptions> = {}) => {
        clearTimer(debounceTimerRef)
        clearTimer(maxWaitTimerRef)
        clearTimer(encodeTimerRef)
        performSaveRef.current({ encode: options.encode ?? true, keepalive: options.keepalive ?? false })
    }, [])

    const reset = useCallback((newContent: string) => {
        generationRef.current += 1
        clearTimer(debounceTimerRef)
        clearTimer(maxWaitTimerRef)
        clearTimer(encodeTimerRef)
        clearTimer(retryTimerRef)
        pendingRef.current = null
        contentRef.current = newContent
        lastSavedContentRef.current = newContent
        lastEncodedContentRef.current = newContent
        setStatus('idle')
    }, [])

    useEffect(() => {
        contentRef.current = content
        if (!enabled || content === lastSavedContentRef.current) return

        clearTimer(debounceTimerRef)
        debounceTimerRef.current = setTimeout(() => {
            debounceTimerRef.current = null
            clearTimer(maxWaitTimerRef)
            performSaveRef.current({ encode: false, keepalive: false })
        }, debounceMs)

        // Continuous typing keeps postponing the debounce; the max-wait timer
        // guarantees a save at least every maxWaitMs
        if (maxWaitTimerRef.current === null) {
            maxWaitTimerRef.current = setTimeout(() => {
                maxWaitTimerRef.current = null
                clearTimer(debounceTimerRef)
                performSaveRef.current({ encode: false, keepalive: false })
            }, maxWaitMs)
        }

        clearTimer(encodeTimerRef)
        encodeTimerRef.current = setTimeout(() => {
            encodeTimerRef.current = null
            performSaveRef.current({ encode: true, keepalive: false })
        }, encodeIdleMs)
    }, [content, enabled, debounceMs, maxWaitMs, encodeIdleMs])

    // Flush with keepalive when the tab is closed or backgrounded
    useEffect(() => {
        const flushForUnload = () => flush({ encode: true, keepalive: true })
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flushForUnload()
        }
        window.addEventListener('pagehide', flushForUnload)
        document.addEventListener('visibilitychange', onVisibilityChange)
        return () => {
            window.removeEventListener('pagehide', flushForUnload)
            document.removeEventListener('visibilitychange', onVisibilityChange)
        }
    }, [flush])

    // Flush pending edits when the editor unmounts (e.g. navigating away)
    useEffect(() => {
        return () => {
            clearTimer(retryTimerRef)
            flush({ encode: true })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return { status, lastSavedAt, flush, reset }
}
