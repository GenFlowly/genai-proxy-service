import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { LayoutContextType } from '../models/layout.models'
import { MOBILE_BREAKPOINT } from '../constants/breakpoints'

/* ---------- Context ---------- */

const LayoutContext = createContext<LayoutContextType | undefined>(undefined)

/* ---------- Provider ---------- */

export const LayoutProvider = ({ children }: { children: ReactNode }) => {
    const [isLeftSidebarExpanded, setIsLeftSidebarExpanded] = useState(false)
    // Default to collapsed on mobile, expanded on desktop
    const [isRightSidebarExpanded, setIsRightSidebarExpanded] = useState(() => {
        if (typeof window !== 'undefined') {
            return window.innerWidth > MOBILE_BREAKPOINT
        }
        return true
    })

    const [isInstructionWidgetExpanded, setInstructionWidgetExpanded] = useState(false)
    const [isHistoryWidgetExpanded, setHistoryWidgetExpanded] = useState(true)

    const toggleLeftSidebar = useCallback(() => setIsLeftSidebarExpanded(prev => !prev), [])
    const toggleRightSidebar = useCallback(() => setIsRightSidebarExpanded(prev => !prev), [])

    const setLeftSidebarExpanded = useCallback((visible: boolean) => setIsLeftSidebarExpanded(visible), [])
    const setRightSidebarExpanded = useCallback((visible: boolean) => setIsRightSidebarExpanded(visible), [])

    const [isLeftSidebarMinimized, setLeftSidebarMinimized] = useState(false)

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
                isLeftSidebarMinimized,
                setLeftSidebarMinimized,
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
