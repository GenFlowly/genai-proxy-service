import React from 'react'
import { ScrollArea } from '@genflowly/component-library'
import styles from './CenterSection.module.scss'
import { useWidgetResolver } from '../../../hooks/useWidgetResolver'
import { useSidebarMenu } from '../../../context/SidebarMenuContext'

interface CenterSectionProps {
    widgetIds: string[]
    'data-testid'?: string
}

export default function CenterSection({ widgetIds, 'data-testid': testId }: CenterSectionProps) {
    const widgets = useWidgetResolver(widgetIds)
    const { activeWidgetId } = useSidebarMenu()

    // If there's an active widget selected via a sidebar menu, only show that one.
    // Otherwise, show all widgets configured for this center section.
    const displayWidgets = activeWidgetId && widgetIds.includes(activeWidgetId)
        ? widgets.filter(w => w.id === activeWidgetId)
        : widgets

    return (
        <div className={styles.centerSection} data-testid={testId || "center-section"}>
            <ScrollArea className={styles.scrollContainer} data-testid="center-section-scroll">
                <div className={styles.contentWrapper} data-testid="center-section-content">
                    {displayWidgets.map(widget => (
                        <widget.component key={widget.id} />
                    ))}
                </div>
            </ScrollArea>
        </div>
    )
}
