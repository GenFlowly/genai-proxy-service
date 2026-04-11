import React, { createContext, useContext, useState, ReactNode } from 'react'
import { LayoutContextType } from '../models/layout.models'

/* ---------- Context ---------- */

const LayoutContext = createContext<LayoutContextType | undefined>(undefined)

/* ---------- Provider ---------- */

export const LayoutProvider = ({ children }: { children: ReactNode }) => {
    const [isLeftSidebarExpanded, setIsLeftSidebarExpanded] = useState(false)
    // Default to collapsed on mobile (< 768px), expanded on desktop
    const [isRightSidebarExpanded, setIsRightSidebarExpanded] = useState(() => {
        if (typeof window !== 'undefined') {
            return window.innerWidth > 768
        }
        return true
    })

    const [isInstructionWidgetExpanded, setInstructionWidgetExpanded] = useState(false)
    const [isHistoryWidgetExpanded, setHistoryWidgetExpanded] = useState(true)

    const toggleLeftSidebar = () => setIsLeftSidebarExpanded(prev => !prev)
    const toggleRightSidebar = () => setIsRightSidebarExpanded(prev => !prev)

    const setLeftSidebarExpanded = (visible: boolean) => setIsLeftSidebarExpanded(visible)
    const setRightSidebarExpanded = (visible: boolean) => setIsRightSidebarExpanded(visible)

    return (
        <LayoutContext.Provider
            value={{
                isLeftSidebarExpanded,
                isRightSidebarExpanded,
                toggleLeftSidebar,
                toggleRightSidebar,
                setLeftSidebarExpanded,
                setRightSidebarExpanded,
                isInstructionWidgetExpanded,
                setInstructionWidgetExpanded,
                isHistoryWidgetExpanded,
                setHistoryWidgetExpanded,
            }}
        >
            {children}
        </LayoutContext.Provider>
    )
}

/* ---------- Hook ---------- */

export const useLayout = (): LayoutContextType => {
    const context = useContext(LayoutContext)
    if (!context) throw new Error('useLayout must be used within a LayoutProvider')
    return context
}
