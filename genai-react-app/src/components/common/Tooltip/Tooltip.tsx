import React, { useState, useRef, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './Tooltip.module.scss'

interface TooltipProps {
    content: string
    children: ReactNode
}

export default function Tooltip({ content, children }: TooltipProps) {
    const [isVisible, setIsVisible] = useState(false)
    const [position, setPosition] = useState({ top: 0, left: 0 })
    const [placement, setPlacement] = useState<'right' | 'left' | 'top' | 'bottom'>('right')
    const containerRef = useRef<HTMLDivElement>(null)
    const tooltipRef = useRef<HTMLDivElement>(null)

    // Using useLayoutEffect to prevent flickering
    React.useLayoutEffect(() => {
        if (isVisible && containerRef.current && tooltipRef.current) {
            const anchor = containerRef.current.getBoundingClientRect()
            const tooltip = tooltipRef.current.getBoundingClientRect()
            const gap = 8

            // Defaults to 'right'
            let newTop = anchor.top + anchor.height / 2
            let newLeft = anchor.right + gap
            let newPlacement: 'right' | 'left' | 'top' | 'bottom' = 'right'

            // Check collision with right edge
            if (newLeft + tooltip.width > window.innerWidth) {
                // Try 'left'
                const leftPos = anchor.left - gap - tooltip.width
                if (leftPos > 0) {
                    newLeft = leftPos
                    newPlacement = 'left'
                } else {
                    // Try 'top' ? For now let's stick to simple flipping or clamp
                    // If neither fits, we might just have to clamp or prioritize one
                    // Let's try to flip to bottom if side doesn't work?
                    // For sidebars, usually flipping X is enough.
                    // But if it's strictly requested to fit:

                    // Simple fallback: keep left but clamp? 
                    // Let's assume flipping to Left is sufficient for Right Sidebar case.
                    newLeft = leftPos
                    newPlacement = 'left'
                }
            }

            // Adjust vertical for right/left placement
            if (newPlacement === 'right' || newPlacement === 'left') {
                // Check top collision (centered)
                const halfHeight = tooltip.height / 2
                if (newTop - halfHeight < 0) {
                    newTop = halfHeight + gap // Push down
                } else if (newTop + halfHeight > window.innerHeight) {
                    newTop = window.innerHeight - halfHeight - gap // Push up
                }
            }

            setPosition({ top: newTop, left: newLeft })
            setPlacement(newPlacement)
        }
    }, [isVisible])

    return (
        <>
            <div
                ref={containerRef}
                className={styles.tooltipContainer}
                onMouseEnter={() => setIsVisible(true)}
                onMouseLeave={() => setIsVisible(false)}
            >
                {children}
            </div>
            {isVisible && content && createPortal(
                <div
                    ref={tooltipRef}
                    className={`${styles.tooltip} ${styles[`placement-${placement}`]} `}
                    style={{
                        top: `${position.top}px`,
                        left: `${position.left}px`,
                        // transform is now handled by CSS classes based on placement
                    }}
                >
                    {content}
                </div>,
                document.body
            )}
        </>
    )
}
