import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useLayout } from './LayoutContext'
import { MenuLocationState } from '../hooks/useAppMenu'
import { useResponsiveBreakpoints } from '../hooks/useResponsiveBreakpoints'

export type MenuLayer = 'l1' | 'l2'

/** Where a page's Back goes, and the menu request it arrives with. */
export interface SwipeBack {
    to: string
    state?: MenuLocationState
}

/** What the page's top-left button does, which a swipe from the left edge stands in for. */
export type PageSwipeAction = { kind: 'menu'; layer: MenuLayer } | ({ kind: 'back' } & SwipeBack)

/** Where a swipe has to start: the strip along the left edge of the screen. */
export const EDGE_ZONE = 24
/** Movement before a touch counts as a swipe rather than a tap or a scroll. */
const LOCK_DISTANCE = 10
/** Released past this share of the screen, or flicked, the swipe goes through. */
const COMMIT_FRACTION = 0.3
const COMMIT_VELOCITY = 0.5 // px per ms

interface EdgeSwipeContextValue {
    /** The menu a finger is dragging in from the left edge. */
    draggedLayer: MenuLayer | null
    /** A SlidePanel hands over its element so the finger can move it. */
    attachPanel: (layer: MenuLayer, element: HTMLElement | null) => void
    registerPageAction: (action: PageSwipeAction) => () => void
}

const EdgeSwipeContext = createContext<EdgeSwipeContextValue>({
    draggedLayer: null,
    attachPanel: () => {},
    registerPageAction: () => () => {},
})

interface Swipe {
    startX: number
    startY: number
    target: Element
    action: { kind: 'drag'; layer: MenuLayer } | ({ kind: 'back' } & SwipeBack)
    isClaimed: boolean
    dx: number
    lastX: number
    lastTime: number
    velocity: number
}

/**
 * Which surface a touch landed on: a menu, the page, or something that owns
 * its own touches (a dialog, or anything portaled out of the app root).
 */
function touchedSurface(target: Element): MenuLayer | 'page' | null {
    const panel = target.closest<HTMLElement>('[data-swipe-layer]')
    const dialog = target.closest('[aria-modal="true"]')
    if (panel) {
        // The menu itself is a dialog; one raised inside it is not
        if (dialog && dialog !== panel.firstElementChild && panel.contains(dialog)) return null
        return panel.dataset.swipeLayer as MenuLayer
    }
    if (dialog || !document.getElementById('root')?.contains(target)) return null
    return 'page'
}

/** A rightward drag on content scrolled sideways scrolls it back instead. */
function canScrollBack(target: Element): boolean {
    for (let element: Element | null = target; element && element !== document.body; element = element.parentElement) {
        if (element.scrollLeft > 0 && /auto|scroll/.test(getComputedStyle(element).overflowX)) return true
    }
    return false
}

/**
 * The touch had to be cancelled at its start to keep Safari's back swipe off
 * it, which also cost it the browser's click, so a tap gets one here.
 */
function tap(target: Element, touch: Touch | undefined): void {
    const editable = target.closest<HTMLElement>('input, textarea, select, [contenteditable="true"]')
    editable?.focus()
    target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: touch?.clientX ?? 0,
        clientY: touch?.clientY ?? 0,
    }))
}

/**
 * Below isNarrow, a swipe from the left edge opens the page's L2 Menu (or the
 * L1 Menu when it has none), or goes back on a page nested under another. On
 * the L2 Menu it opens the L1 Menu. Menus follow the finger; released early
 * they slide back.
 */
export function EdgeSwipeProvider({ children }: { children: ReactNode }): React.ReactElement {
    const { isNarrow } = useResponsiveBreakpoints()
    const { setLeftSidebarExpanded } = useLayout()
    const navigate = useNavigate()
    const location = useLocation()
    const [draggedLayer, setDraggedLayer] = useState<MenuLayer | null>(null)

    const panels = useRef<Partial<Record<MenuLayer, HTMLElement>>>({})
    const pageAction = useRef<PageSwipeAction | null>(null)
    const swipe = useRef<Swipe | null>(null)
    const latest = useRef({ location, navigate, setLeftSidebarExpanded })
    latest.current = { location, navigate, setLeftSidebarExpanded }

    const placePanel = useCallback((element: HTMLElement, dx: number) => {
        element.style.transform = `translateX(${Math.min(0, dx - window.innerWidth)}px)`
    }, [])

    const attachPanel = useCallback((layer: MenuLayer, element: HTMLElement | null) => {
        if (!element) {
            delete panels.current[layer]
            return
        }
        panels.current[layer] = element
        const current = swipe.current
        if (current?.isClaimed && current.action.kind === 'drag' && current.action.layer === layer) {
            placePanel(element, current.dx)
        }
    }, [placePanel])

    const registerPageAction = useCallback((action: PageSwipeAction) => {
        pageAction.current = action
        return () => {
            if (pageAction.current === action) pageAction.current = null
        }
    }, [])

    useEffect(() => {
        if (!isNarrow) return

        const handleStart = (event: TouchEvent) => {
            swipe.current = null
            const touch = event.touches[0]
            if (event.touches.length !== 1 || touch.clientX > EDGE_ZONE || !(event.target instanceof Element)) return

            const surface = touchedSurface(event.target)
            let action: Swipe['action'] | null = null
            if (surface === 'l2') action = { kind: 'drag', layer: 'l1' }
            if (surface === 'page' && pageAction.current) {
                action = pageAction.current.kind === 'back'
                    ? pageAction.current
                    : { kind: 'drag', layer: pageAction.current.layer }
            }
            if (!action) return

            // Safari's own back swipe starts from the same edge; only a cancelled touchstart keeps it out
            if (event.cancelable) event.preventDefault()
            swipe.current = {
                startX: touch.clientX,
                startY: touch.clientY,
                target: event.target,
                action,
                isClaimed: false,
                dx: 0,
                lastX: touch.clientX,
                lastTime: performance.now(),
                velocity: 0,
            }
        }

        const handleMove = (event: TouchEvent) => {
            const current = swipe.current
            if (!current) return
            const touch = event.touches[0]
            const dx = touch.clientX - current.startX
            const dy = touch.clientY - current.startY

            if (!current.isClaimed) {
                if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) return
                if (dx <= Math.abs(dy) || canScrollBack(current.target)) {
                    swipe.current = null
                    return
                }
                current.isClaimed = true
                if (current.action.kind === 'drag') setDraggedLayer(current.action.layer)
            }

            if (event.cancelable) event.preventDefault()
            const now = performance.now()
            const elapsed = now - current.lastTime
            if (elapsed > 0) current.velocity = (touch.clientX - current.lastX) / elapsed
            current.lastX = touch.clientX
            current.lastTime = now
            current.dx = Math.max(0, dx)

            if (current.action.kind === 'drag') {
                const element = panels.current[current.action.layer]
                if (element) placePanel(element, current.dx)
            }
        }

        const finish = (commits: boolean) => {
            const current = swipe.current
            swipe.current = null
            if (!current?.isClaimed) return

            const { location: here, navigate: go, setLeftSidebarExpanded: setL2Open } = latest.current
            if (current.action.kind === 'back') {
                if (commits) go(current.action.to, { state: current.action.state })
                return
            }
            if (commits) {
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
                if (current.action.layer === 'l2') setL2Open(true)
                // A swipe is no user gesture to the browser, and Back skips any page that adds
                // history without one, so the swiped-in L1 takes over the page's entry instead
                else go(here, { replace: true, state: { ...(here.state as MenuLocationState | null), appMenu: true } })
            }
            setDraggedLayer(null)
        }

        const handleEnd = (event: TouchEvent) => {
            const current = swipe.current
            if (current && !current.isClaimed) {
                swipe.current = null
                tap(current.target, event.changedTouches?.[0])
                return
            }
            finish(!!current && (current.dx > window.innerWidth * COMMIT_FRACTION || current.velocity > COMMIT_VELOCITY))
        }
        // The browser took the touch over, e.g. for its own back swipe
        const handleCancel = () => finish(false)

        document.addEventListener('touchstart', handleStart, { capture: true, passive: false })
        document.addEventListener('touchmove', handleMove, { capture: true, passive: false })
        document.addEventListener('touchend', handleEnd, { capture: true })
        document.addEventListener('touchcancel', handleCancel, { capture: true })
        return () => {
            document.removeEventListener('touchstart', handleStart, { capture: true })
            document.removeEventListener('touchmove', handleMove, { capture: true })
            document.removeEventListener('touchend', handleEnd, { capture: true })
            document.removeEventListener('touchcancel', handleCancel, { capture: true })
            swipe.current = null
            setDraggedLayer(null)
        }
    }, [isNarrow, placePanel])

    const value = useMemo(
        () => ({ draggedLayer, attachPanel, registerPageAction }),
        [draggedLayer, attachPanel, registerPageAction]
    )
    return <EdgeSwipeContext.Provider value={value}>{children}</EdgeSwipeContext.Provider>
}

export function useEdgeSwipe(): EdgeSwipeContextValue {
    return useContext(EdgeSwipeContext)
}

/**
 * Tells the edge swipe what to do on this page: open a menu, or go back when
 * the page is nested under another.
 */
export function useEdgeSwipePageAction(menuLayer: MenuLayer, back?: SwipeBack): void {
    const { registerPageAction } = useEdgeSwipe()
    const backTo = back?.to
    const backState = back?.state
    useEffect(
        () => registerPageAction(backTo ? { kind: 'back', to: backTo, state: backState } : { kind: 'menu', layer: menuLayer }),
        [registerPageAction, menuLayer, backTo, backState]
    )
}
