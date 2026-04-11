import React, { createContext, useContext, useState, ReactNode } from 'react'
import { PageId } from '../config/PageWidgetConfig'

interface SidebarMenuContextType {
    activeWidgetId: string | null
    setActiveWidgetId: (id: string | null) => void
    pageId: PageId | null
}

const SidebarMenuContext = createContext<SidebarMenuContextType | undefined>(undefined)

export const SidebarMenuProvider = ({
    children,
    initialWidgetId = null,
    pageId,
}: {
    children: ReactNode
    initialWidgetId?: string | null
    pageId: PageId
}) => {
    const [activeWidgetId, setActiveWidgetId] = useState<string | null>(initialWidgetId)

    return (
        <SidebarMenuContext.Provider value={{ activeWidgetId, setActiveWidgetId, pageId }}>
            {children}
        </SidebarMenuContext.Provider>
    )
}

export const useSidebarMenu = () => {
    const context = useContext(SidebarMenuContext)
    if (context === undefined) {
        return { activeWidgetId: null, setActiveWidgetId: () => {}, pageId: null }
    }
    return context
}
