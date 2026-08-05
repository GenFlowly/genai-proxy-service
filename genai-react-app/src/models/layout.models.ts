/**
 * Represents the layout state and actions for sidebar management.
 */
export interface LayoutContextType {
    isLeftSidebarExpanded: boolean
    isRightSidebarExpanded: boolean
    toggleLeftSidebar: () => void
    toggleRightSidebar: () => void
    setLeftSidebarExpanded: (visible: boolean) => void
    setRightSidebarExpanded: (visible: boolean) => void
    isInstructionWidgetExpanded: boolean
    setInstructionWidgetExpanded: (expanded: boolean) => void
    isHistoryWidgetExpanded: boolean
    setHistoryWidgetExpanded: (expanded: boolean) => void
    isLeftSidebarMinimized: boolean
    setLeftSidebarMinimized: (minimized: boolean) => void
}
