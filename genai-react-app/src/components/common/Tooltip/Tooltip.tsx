import React, { useState, useRef, useEffect, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './Tooltip.module.scss'

interface TooltipProps {
    content: string
    children: ReactNode
}

export default function Tooltip({ content, children }: TooltipProps) {
    const [isVisible, setIsVisible] = useState(false)
    const [position, setPosition] = useState({ top: 0, left: 0 })
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (isVisible && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect()
            setPosition({
                top: rect.top + rect.height / 2,
                left: rect.right + 8 // 8px gap from the button
            })
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
                    className={styles.tooltip}
                    style={{
                        top: `${position.top}px`,
                        left: `${position.left}px`,
                        transform: 'translateY(-50%)'
                    }}
                >
                    {content}
                </div>,
                document.body
            )}
        </>
    )
}
