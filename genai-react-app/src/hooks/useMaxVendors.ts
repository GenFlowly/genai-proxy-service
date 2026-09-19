import { useEffect, useState } from 'react'

// Minimum conversation-widget width (px) that fits two response columns side
// by side. Above it (desktop, tablet in landscape) two vendors may be shown;
// below it (mobile, tablet in portrait) only one.
const TWO_COLUMN_MIN_WIDTH_PX = 900

/**
 * How many vendor responses (TextContainer columns) fit in the conversation
 * widget, measured from the widget's own width — not the window's — so
 * sidebars opening/closing count too. Pass the response container element
 * (via a ref callback); returns 1 until it is measured.
 */
export function useMaxVendors(container: HTMLElement | null): number {
    const [maxVendors, setMaxVendors] = useState(1)

    useEffect(() => {
        if (!container) return
        const update = () =>
            setMaxVendors(container.clientWidth >= TWO_COLUMN_MIN_WIDTH_PX ? 2 : 1)
        update()
        const observer = new ResizeObserver(update)
        observer.observe(container)
        return () => observer.disconnect()
    }, [container])

    return maxVendors
}
