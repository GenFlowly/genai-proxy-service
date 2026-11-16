import React from 'react'
import { ScrollArea } from '@genflowly/component-library'
import styles from './CenterSection.module.scss'
import { useWidgetResolver } from '../../../hooks/useWidgetResolver'

interface CenterSectionProps {
    widgetIds: string[]
    'data-testid'?: string
}

export default function CenterSection({ widgetIds, 'data-testid': testId }: CenterSectionProps) {
    const widgets = useWidgetResolver(widgetIds)

    return (
        <div className={styles.centerSection} data-testid={testId || "center-section"}>
            <ScrollArea className={styles.scrollContainer} data-testid="center-section-scroll">
                <div className={styles.contentWrapper} data-testid="center-section-content">
                    {widgets.map(widget => (
                        <widget.component key={widget.id} />
                    ))}
                </div>
            </ScrollArea>
        </div>
    )
}
