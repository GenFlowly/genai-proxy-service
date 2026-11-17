import React from 'react'
import { useLocation } from 'react-router'
import { MobileHeader as BaseMobileHeader, MobileMenu } from '@genflowly/component-library'
import type { MobileHeaderMenuItem, MobileHeaderTrailingAction, MobileMenuAction } from '@genflowly/component-library'
import { SwipeBack, useEdgeSwipePageAction } from '../../../context/EdgeSwipeContext'
import { useLayout } from '../../../context/LayoutContext'
import { MenuLocationState, useOpenAppMenu } from '../../../hooks/useAppMenu'
import { SlidePanel } from '../../common/SlidePanel/SlidePanel'

export type { MobileHeaderMenuItem }

interface MobileHeaderProps {
    title: string
    /** Second line under the title (e.g. the loaded instruction persona). */
    subtitle?: React.ReactNode
    /** Makes the subtitle tappable (e.g. to open the instruction picker). */
    onSubtitleClick?: () => void
    /** Makes the title tappable, with a chevron (e.g. to open the Outline). */
    onTitleClick?: () => void
    /** Accessible name of the tappable title. */
    titleActionLabel?: string
    /** What the title opens is showing: its chevron turns up. */
    titleExpanded?: boolean
    /** Entries of the kebab (3-dot) menu on the right; omit to hide the kebab. */
    menuItems?: MobileHeaderMenuItem[]
    /** A round icon button on the right (e.g. a settings page's info button), shown when there are no menuItems. */
    trailingAction?: MobileHeaderTrailingAction
    /** Accessible name of the page-context menu view (e.g. "History", "Saved Notes"). */
    menuTitle?: string
    /** The page's create action, centered in the page-context menu's top bar. */
    menuAction?: MobileMenuAction
    /**
     * The page's L2 Menu content (conversation history, saved notes).
     * Omit it and the hamburger opens the L1 Menu directly.
     */
    menuContent?: React.ReactNode
    /** Set on pages nested under another: a swipe from the left edge goes back instead of opening a menu. */
    swipeBack?: SwipeBack
    children?: React.ReactNode
}

/**
 * 📱 App wiring around the library's presentational MobileHeader: the
 * hamburger drives the layout context and opens the page's L2 Menu, with the
 * L1 Menu one hamburger deeper. A swipe from the left edge does the same, or
 * goes back on a nested page.
 */
export default function MobileHeader({
    title,
    subtitle,
    onSubtitleClick,
    onTitleClick,
    titleActionLabel,
    titleExpanded,
    menuItems,
    trailingAction,
    menuTitle,
    menuAction,
    menuContent,
    swipeBack,
    children,
}: MobileHeaderProps): React.ReactElement {
    const { isLeftSidebarExpanded, toggleLeftSidebar, setLeftSidebarExpanded } = useLayout()
    const openAppMenu = useOpenAppMenu()
    const location = useLocation()
    const hasL2Menu = menuContent != null
    // Picked in the L1 Menu: the L2 Menu is already there as L1 slides away
    const opensFromL1Menu = !!(location.state as MenuLocationState | null)?.openMobileMenu

    useEdgeSwipePageAction(hasL2Menu ? 'l2' : 'l1', swipeBack)

    return (
        <>
            <BaseMobileHeader
                title={title}
                subtitle={subtitle}
                onSubtitleClick={onSubtitleClick}
                onTitleClick={onTitleClick}
                titleActionLabel={titleActionLabel}
                titleExpanded={titleExpanded}
                menuItems={menuItems}
                trailingAction={trailingAction}
                onMenuClick={hasL2Menu ? toggleLeftSidebar : openAppMenu}
            />
            {hasL2Menu && (
                <SlidePanel layer="l2" open={isLeftSidebarExpanded} appearInPlace={opensFromL1Menu}>
                    <MobileMenu
                        title={menuTitle}
                        action={menuAction}
                        onOpenAppMenu={openAppMenu}
                        onClose={() => setLeftSidebarExpanded(false)}
                        data-testid="mobile-header-menu-overlay"
                    >
                        {menuContent}
                    </MobileMenu>
                </SlidePanel>
            )}
            {children}
        </>
    )
}
