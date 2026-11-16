/**
 * Layout state shared across pages: the phone overlays every page uses, and
 * the desktop chat page's two side panels.
 */
export interface LayoutContextType {
    /** 📱 The page's L2 Menu overlay is open. */
    isLeftSidebarExpanded: boolean
    /** 📱 The chat page's AI Settings modal is open. */
    isRightSidebarExpanded: boolean
    toggleLeftSidebar: () => void
    toggleRightSidebar: () => void
    setLeftSidebarExpanded: (visible: boolean) => void
    setRightSidebarExpanded: (visible: boolean) => void
    /** 🖥️ The chat sidebar shows its Projects and Chats cards (false: the rail). Remembered per browser. */
    isChatSidebarExpanded: boolean
    setChatSidebarExpanded: (expanded: boolean) => void
    toggleChatSidebar: () => void
    /** 🖥️ The AI settings dock shows its cards (false: the strip). Remembered per browser. */
    isAiDockExpanded: boolean
    setAiDockExpanded: (expanded: boolean) => void
    toggleAiDock: () => void
}
