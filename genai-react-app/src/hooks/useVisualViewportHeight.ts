import { useEffect } from 'react'

/**
 * Publishes the visual viewport's height (--vvh) and top offset (--vv-offset)
 * as CSS variables on <html>.
 *
 * Unlike 100vh/100dvh, visualViewport.height shrinks when the mobile
 * on-screen keyboard opens (including iOS Safari, where the keyboard only
 * overlays the layout viewport). --vv-offset captures iOS Safari nudging the
 * visual viewport down (offsetTop) to keep a focused field in view; elements
 * glued to the keyboard's top edge need both:
 * layout-viewport Y of the keyboard top = var(--vv-offset) + var(--vvh).
 */
export function useVisualViewportHeight(): void {
    useEffect(() => {
        if (typeof window === 'undefined' || !window.visualViewport) return

        const viewport = window.visualViewport
        let rafId: number | null = null
        let lastHeight = -1
        let lastOffset = -1

        // The keyboard animation fires a burst of resize/scroll events;
        // coalesce them to one style write per frame, and skip writes when
        // nothing actually changed — every write triggers style recalc and
        // restarts any transition keyed on these vars (visible as jitter).
        function writeViewportVars() {
            rafId = null
            const height = Math.round(viewport.height)
            const offset = Math.round(viewport.offsetTop)
            if (height === lastHeight && offset === lastOffset) return
            lastHeight = height
            lastOffset = offset
            document.documentElement.style.setProperty('--vvh', `${height}px`)
            document.documentElement.style.setProperty('--vv-offset', `${offset}px`)
        }

        function scheduleUpdate() {
            if (rafId === null) rafId = requestAnimationFrame(writeViewportVars)
        }

        viewport.addEventListener('resize', scheduleUpdate)
        // iOS moves the visual viewport (offsetTop) rather than resizing on
        // some focus scenarios; track scroll too so the vars stay accurate
        viewport.addEventListener('scroll', scheduleUpdate)
        // bfcache restores skip effects and may fire no resize event, leaving
        // the vars stale (e.g. a keyboard-open height from before navigating
        // away); re-read them whenever the page is shown
        window.addEventListener('pageshow', scheduleUpdate)

        writeViewportVars()

        return () => {
            viewport.removeEventListener('resize', scheduleUpdate)
            viewport.removeEventListener('scroll', scheduleUpdate)
            window.removeEventListener('pageshow', scheduleUpdate)
            if (rafId !== null) cancelAnimationFrame(rafId)
            document.documentElement.style.removeProperty('--vvh')
            document.documentElement.style.removeProperty('--vv-offset')
        }
    }, [])
}
