import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import styles from './CenterSection.module.scss'
import { useWidgetResolver } from '../../../hooks/useWidgetResolver'

interface CenterSectionProps {
    widgetIds: string[]
    'data-testid'?: string
}

export default function CenterSection({ widgetIds, 'data-testid': testId }: CenterSectionProps) {
    const widgets = useWidgetResolver(widgetIds)
    const { isInstructionWidgetExpanded } = useLayout()

    return (
        <div className={styles.centerSection} data-testid={testId || "center-section"}>
            <div className={styles.contentWrapper} data-testid="center-section-content">
                <div
                    id="instruction-widget-scroll-anchor"
                    style={{
                        width: '100%',
                        position: !isInstructionWidgetExpanded ? 'sticky' : undefined,
                        top: !isInstructionWidgetExpanded ? 0 : undefined,
                        zIndex: 10,
                        backgroundColor: !isInstructionWidgetExpanded ? 'var(--color-sidebar-background)' : undefined
                    }}
                >
                </div>
                {widgets.map(widget => (
                    <widget.component key={widget.id} />
                ))}
            </div>
        </div>
    )
}
