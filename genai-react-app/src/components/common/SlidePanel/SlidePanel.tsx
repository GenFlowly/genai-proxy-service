import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { MenuLayer, useEdgeSwipe } from '../../../context/EdgeSwipeContext'
import styles from './SlidePanel.module.scss'

const DURATION = 250
const EASING = 'cubic-bezier(0.2, 0, 0, 1)'
const OFF_SCREEN = 'translateX(-100%)'

/**
 * Moves the panel from wherever it is now, mid-animation or under a finger.
 * Returns nothing when there is nothing to animate.
 */
function slide(element: HTMLElement, to: string): Promise<void> | undefined {
    const from = getComputedStyle(element).transform || 'none'
    element.getAnimations?.().forEach((animation) => animation.cancel())
    // A transform left at rest would become the containing block of the menu's fixed layout
    element.style.transform = to === 'none' ? '' : to
    if (typeof element.animate !== 'function' || from === to) return undefined

    const reducesMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const animation = element.animate(
        [{ transform: from }, { transform: to }],
        { duration: reducesMotion ? 0 : DURATION, easing: EASING }
    )
    return animation.finished.then(() => undefined, () => undefined)
}

interface SlidePanelProps {
    layer: MenuLayer
    open: boolean
    /** Shows without sliding in, under a menu that is sliding away. */
    appearInPlace?: boolean
    children: React.ReactNode
}

/**
 * A full-screen menu that enters from the left and leaves to the left, and
 * follows the finger while an edge swipe drags it in.
 */
export function SlidePanel({ layer, open, appearInPlace = false, children }: SlidePanelProps): React.ReactElement | null {
    const { draggedLayer, attachPanel } = useEdgeSwipe()
    const isDragged = draggedLayer === layer
    const isShown = open || isDragged
    const [isRendered, setIsRendered] = useState(isShown)
    const elementRef = useRef<HTMLDivElement | null>(null)
    // Shown on mount means there was nothing for it to slide in over
    const wasShown = useRef(isShown)
    const isShownRef = useRef(isShown)
    isShownRef.current = isShown
    const isFresh = useRef(false)

    if (isShown && !isRendered) setIsRendered(true)

    const setElement = useCallback((element: HTMLDivElement | null) => {
        elementRef.current = element
        isFresh.current = !!element
        attachPanel(layer, element)
    }, [attachPanel, layer])

    useLayoutEffect(() => {
        const element = elementRef.current
        const isEntering = isShown && !wasShown.current
        // Reopened while sliding out, it turns around from where it is
        const startsOffScreen = isEntering && isFresh.current
        wasShown.current = isShown
        isFresh.current = false
        if (!element || isDragged) return

        if (!isShown) {
            const sliding = slide(element, OFF_SCREEN)
            if (!sliding) setIsRendered(false)
            else sliding.then(() => { if (!isShownRef.current) setIsRendered(false) })
            return
        }
        if (isEntering && appearInPlace) {
            element.getAnimations?.().forEach((animation) => animation.cancel())
            element.style.transform = ''
            return
        }
        if (startsOffScreen) element.style.transform = OFF_SCREEN
        slide(element, 'none')
        // appearInPlace only counts at the moment the panel enters
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isShown, isDragged])

    if (!isRendered) return null
    return (
        <div
            ref={setElement}
            className={`${styles.panel} ${styles[layer]}`}
            data-swipe-layer={layer}
            data-testid={`slide-panel-${layer}`}
        >
            {children}
        </div>
    )
}
