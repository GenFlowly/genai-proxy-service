import React from 'react'
import { MobileHeader as BaseMobileHeader, MobileMenu } from '@genflowly/component-library'
import type { MobileHeaderMenuItem, MobileMenuAction } from '@genflowly/component-library'
import { useLayout } from '../../../context/LayoutContext'
import { useOpenAppMenu } from '../../../hooks/useAppMenu'

export type { MobileHeaderMenuItem }

interface MobileHeaderProps {
    title: string
    /** Second line under the title (e.g. the loaded instruction persona). */
    subtitle?: React.ReactNode
    /** Makes the subtitle tappable (e.g. to open the instruction picker). */
    onSubtitleClick?: () => void
    /** Entries of the kebab (3-dot) menu on the right; omit to hide the kebab. */
    menuItems?: MobileHeaderMenuItem[]
    /** Accessible name of the page-context menu view (e.g. "History", "Saved Notes"). */
    menuTitle?: string
    /** The page's create action, centered in the page-context menu's top bar. */
    menuAction?: MobileMenuAction
    /**
     * The page's L2 Menu content (conversation history, saved notes).
     * Omit it and the hamburger opens the L1 Menu directly.
     */
    menuContent?: React.ReactNode
    children?: React.ReactNode
}

/**
 * 📱 App wiring around the library's presentational MobileHeader: the
 * hamburger drives the layout context and opens the page's L2 Menu, with the
 * L1 Menu one hamburger deeper.
 */
export default function MobileHeader({
    title,
    subtitle,
    onSubtitleClick,
    menuItems,
    menuTitle,
    menuAction,
    menuContent,
    children,
}: MobileHeaderProps): React.ReactElement {
    const { isLeftSidebarExpanded, toggleLeftSidebar, setLeftSidebarExpanded } = useLayout()
    const openAppMenu = useOpenAppMenu()
    const hasL2Menu = menuContent != null

    return (
        <>
            <BaseMobileHeader
                title={title}
                subtitle={subtitle}
                onSubtitleClick={onSubtitleClick}
                menuItems={menuItems}
                onMenuClick={hasL2Menu ? toggleLeftSidebar : openAppMenu}
            />
            {hasL2Menu && isLeftSidebarExpanded && (
                <MobileMenu
                    title={menuTitle}
                    action={menuAction}
                    onOpenAppMenu={openAppMenu}
                    onClose={() => setLeftSidebarExpanded(false)}
                    data-testid="mobile-header-menu-overlay"
                >
                    {menuContent}
                </MobileMenu>
            )}
            {children}
        </>
    )
}
