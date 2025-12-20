import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './PromptEditorTooltip.module.scss'

interface PromptEditorTooltipProps {
    top: number
    left: number
    visible: boolean
    onMarkReusable: () => void
}

export default function PromptEditorTooltip({ top, left, visible, onMarkReusable }: PromptEditorTooltipProps) {
    if (!visible) return null

    return createPortal(
        <div
            className={styles.tooltipContainer}
            style={{
                top: `${top - 10}px`, // Slight offset above
                left: `${left}px`,
            }}
            onMouseDown={(e) => e.preventDefault()} // Prevent stealing focus
        >
            <button className={styles.button} onClick={onMarkReusable}>
                Mark as Reusable
            </button>
        </div>,
        document.body
    )
}
