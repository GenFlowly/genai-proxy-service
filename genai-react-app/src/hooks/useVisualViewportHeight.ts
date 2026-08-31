import { useEffect } from 'react'

/**
 * Publishes the visual viewport height as a CSS variable (--vvh) on <html>.
 *
 * Unlike 100vh/100dvh, visualViewport.height shrinks when the mobile
 * on-screen keyboard opens (including iOS Safari, where the keyboard only
 * overlays the layout viewport). Fixed-height screens can size themselves
 * with calc(var(--vvh, 100dvh) ...) so content above the keyboard stays
 * visible.
 */
export function useVisualViewportHeight(): void {
    useEffect(() => {
        if (typeof window === 'undefined' || !window.visualViewport) return

        const viewport = window.visualViewport

        function updateViewportHeight() {
            document.documentElement.style.setProperty('--vvh', `${viewport.height}px`)
        }

        viewport.addEventListener('resize', updateViewportHeight)
        // iOS moves the visual viewport (offsetTop) rather than resizing on
        // some focus scenarios; track scroll too so the var stays accurate
        viewport.addEventListener('scroll', updateViewportHeight)

        updateViewportHeight()

        return () => {
            viewport.removeEventListener('resize', updateViewportHeight)
            viewport.removeEventListener('scroll', updateViewportHeight)
            document.documentElement.style.removeProperty('--vvh')
        }
    }, [])
}
