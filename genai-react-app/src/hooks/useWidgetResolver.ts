import { useMemo } from 'react'
import { WIDGET_REGISTRY, WidgetContext, WidgetDefinition } from '../registry/WidgetRegistry'

export const useWidgetResolver = (widgetIds: string[], context: WidgetContext = {}): WidgetDefinition[] => {
    return useMemo(() => {
        return widgetIds
            .map(id => WIDGET_REGISTRY[id])
            .filter(widget => {
                if (!widget) {
                    console.warn(`Widget with ID '${widget}' not found in registry.`)
                    return false
                }
                if (widget.isVisible && !widget.isVisible(context)) {
                    return false
                }
                return true
            })
    }, [widgetIds, context])
}
