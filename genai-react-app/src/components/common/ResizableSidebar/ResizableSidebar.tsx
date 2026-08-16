import React, { ReactNode, useCallback, useRef, useState } from 'react'
import styles from './ResizableSidebar.module.scss'

// Resize bounds for the panel (px)
const DEFAULT_MIN_WIDTH = 160 // matches the panel's default 10rem
const DEFAULT_MAX_WIDTH = 480

const rootFontSizePx = (): number =>
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

export interface ResizableSidebarProps {
    // localStorage key the panel width is persisted under (in rem, so it
    // stays relative to the root font size)
    storageKey: string
    minWidth?: number
    maxWidth?: number
    children: ReactNode
    'data-testid'?: string
    handleTestId?: string
}

/**
 * Drag-resizable side panel: a fixed-width column with a drag handle on its
 * right edge. Width survives toggling (state lives here) and reloads
 * (persisted to localStorage in rem).
 */
export default function ResizableSidebar({
    storageKey,
    minWidth = DEFAULT_MIN_WIDTH,
    maxWidth = DEFAULT_MAX_WIDTH,
    children,
    'data-testid': testId,
    handleTestId,
}: ResizableSidebarProps) {
    const clampWidth = useCallback(
        (px: number): number => Math.min(maxWidth, Math.max(minWidth, px)),
        [minWidth, maxWidth]
    )

    const [width, setWidth] = useState<number>(() => {
        try {
            const savedRem = parseFloat(localStorage.getItem(storageKey) ?? '')
            if (Number.isFinite(savedRem) && savedRem > 0) {
                return clampWidth(savedRem * rootFontSizePx())
            }
        } catch {
            // localStorage unavailable (private mode, etc.) — fall through to default
        }
        return minWidth
    })
    const panelRef = useRef<HTMLDivElement>(null)

    const saveWidth = useCallback((px: number): void => {
        try {
            localStorage.setItem(storageKey, (px / rootFontSizePx()).toFixed(3))
        } catch {
            // Best-effort persistence only
        }
    }, [storageKey])

    const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        const startX = e.clientX
        const startWidth = panelRef.current?.offsetWidth ?? width
        const handle = e.currentTarget
        handle.setPointerCapture?.(e.pointerId)

        let latestWidth = startWidth
        const onPointerMove = (ev: PointerEvent) => {
            latestWidth = clampWidth(startWidth + (ev.clientX - startX))
            setWidth(latestWidth)
        }
        const onPointerEnd = () => {
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerEnd)
            window.removeEventListener('pointercancel', onPointerEnd)
            saveWidth(latestWidth)
        }
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerEnd)
        window.addEventListener('pointercancel', onPointerEnd)
    }, [width, clampWidth, saveWidth])

    return (
        <div
            className={styles.sidebar}
            ref={panelRef}
            style={{ width }}
            data-testid={testId}
        >
            {children}
            <div
                className={styles.resizeHandle}
                onPointerDown={handleResizeStart}
                data-testid={handleTestId}
            />
        </div>
    )
}
