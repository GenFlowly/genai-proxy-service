import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'
import { LayoutContextType } from '../models/layout.models'

/* ---------- Persistence ---------- */

export const CHAT_SIDEBAR_STORAGE_KEY = 'chat_left_sidebar'
export const AI_DOCK_STORAGE_KEY = 'chat_right_dock'

// Per-browser memory of the desktop chat panels; anything unreadable means expanded
const readExpanded = (key: string): boolean => {
    try {
        return localStorage.getItem(key) !== 'collapsed'
    } catch {
        return true
    }
}

const saveExpanded = (key: string, expanded: boolean): void => {
    try {
        localStorage.setItem(key, expanded ? 'expanded' : 'collapsed')
    } catch {
        // Best-effort persistence only
    }
}

/* ---------- Context ---------- */

const LayoutContext = createContext<LayoutContextType | undefined>(undefined)

/* ---------- Provider ---------- */

export const LayoutProvider = ({ children }: { children: ReactNode }) => {
    // 📱 Phone overlays: the page's L2 Menu and the chat page's AI Settings modal
    const [isLeftSidebarExpanded, setIsLeftSidebarExpanded] = useState(false)
    const [isRightSidebarExpanded, setIsRightSidebarExpanded] = useState(false)

    const toggleLeftSidebar = useCallback(() => setIsLeftSidebarExpanded(prev => !prev), [])
    const toggleRightSidebar = useCallback(() => setIsRightSidebarExpanded(prev => !prev), [])
    const setLeftSidebarExpanded = useCallback((visible: boolean) => setIsLeftSidebarExpanded(visible), [])
    const setRightSidebarExpanded = useCallback((visible: boolean) => setIsRightSidebarExpanded(visible), [])

    // 🖥️ Chat page panels: only the user opens or closes them
    const [isChatSidebarExpanded, setChatSidebarExpanded] = useState(() => readExpanded(CHAT_SIDEBAR_STORAGE_KEY))
    const [isAiDockExpanded, setAiDockExpanded] = useState(() => readExpanded(AI_DOCK_STORAGE_KEY))

    useEffect(() => saveExpanded(CHAT_SIDEBAR_STORAGE_KEY, isChatSidebarExpanded), [isChatSidebarExpanded])
    useEffect(() => saveExpanded(AI_DOCK_STORAGE_KEY, isAiDockExpanded), [isAiDockExpanded])

    const toggleChatSidebar = useCallback(() => setChatSidebarExpanded(prev => !prev), [])
    const toggleAiDock = useCallback(() => setAiDockExpanded(prev => !prev), [])

    return (
        <LayoutContext.Provider
            value={{
                isLeftSidebarExpanded,
                isRightSidebarExpanded,
                toggleLeftSidebar,
                toggleRightSidebar,
                setLeftSidebarExpanded,
                setRightSidebarExpanded,
                isChatSidebarExpanded,
                setChatSidebarExpanded,
                toggleChatSidebar,
                isAiDockExpanded,
                setAiDockExpanded,
                toggleAiDock,
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
