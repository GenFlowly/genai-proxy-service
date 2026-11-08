import { fireEvent } from '@testing-library/react'

/** A one-finger swipe in from the left edge of the screen, far enough to go through. */
export function swipeFromLeftEdge(target: Element): void {
    // The swipe only acts on the app's own root, which the test's container stands in for
    const container = target.closest('body > div')
    if (container && !document.getElementById('root')) container.id = 'root'
    const y = 300
    fireEvent.touchStart(target, { touches: [{ clientX: 4, clientY: y }] })
    fireEvent.touchMove(target, { touches: [{ clientX: 40, clientY: y }] })
    fireEvent.touchMove(target, { touches: [{ clientX: window.innerWidth * 0.6, clientY: y }] })
    fireEvent.touchEnd(target, { touches: [] })
}
