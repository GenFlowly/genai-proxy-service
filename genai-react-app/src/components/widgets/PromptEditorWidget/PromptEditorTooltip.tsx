import React from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import styles from './PromptEditorTooltip.module.scss'

interface PromptEditorTooltipProps {
    top: number
    left: number
    visible: boolean
    onMarkReusable: () => void
}

export default function PromptEditorTooltip({ top, left, visible, onMarkReusable }: PromptEditorTooltipProps) {
    const { t } = useTranslation()
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
                {t('editor.promptEditorTooltip.markAsReusable')}
            </button>
        </div>,
        document.body
    )
}
