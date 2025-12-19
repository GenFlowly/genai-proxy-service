import React, { createContext, useContext, useState, ReactNode } from 'react'
import { LayoutContextType } from '../models/layout.models'

/* ---------- Context ---------- */

const LayoutContext = createContext<LayoutContextType | undefined>(undefined)

/* ---------- Provider ---------- */

export const LayoutProvider = ({ children }: { children: ReactNode }) => {
    const [isLeftSidebarExpanded, setIsLeftSidebarExpanded] = useState(false)
    const [isRightSidebarExpanded, setIsRightSidebarExpanded] = useState(true)

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
