import React from 'react'
import { useTranslation } from 'react-i18next'
import { MobileHeader as BaseMobileHeader, MobileMenu } from '@genflowly/component-library'
import type { MobileHeaderMenuItem, MobileMenuAction } from '@genflowly/component-library'
import { useLayout } from '../../../context/LayoutContext'
import { AppMenuContent } from '../../sections/LeftSidebar/AppMenuContent'

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
     * Page-context content of the menu (conversation history, saved notes).
     * Omit it and the hamburger opens the app menu directly.
     */
    menuContent?: React.ReactNode
    children?: React.ReactNode
}

/**
 * 📱 App wiring around the library's presentational MobileHeader: the
 * hamburger drives the layout context and opens the two-level MobileMenu —
 * page context first (history, saved notes), with the app menu (what the
 * desktop navbar shows) one hamburger deeper.
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
    const { t } = useTranslation()
    const { isLeftSidebarExpanded, toggleLeftSidebar, setLeftSidebarExpanded } = useLayout()
    const closeMenu = () => setLeftSidebarExpanded(false)

    return (
        <>
            <BaseMobileHeader
                title={title}
                subtitle={subtitle}
                onSubtitleClick={onSubtitleClick}
                menuItems={menuItems}
                onMenuClick={toggleLeftSidebar}
            />
            {isLeftSidebarExpanded && (
                <MobileMenu
                    title={menuTitle}
                    action={menuAction}
                    appMenuTitle={t('layout.mobileMenu.menu')}
                    appMenu={<AppMenuContent onNavigate={closeMenu} />}
                    onClose={closeMenu}
                    data-testid="mobile-header-menu-overlay"
                >
                    {menuContent}
                </MobileMenu>
            )}
            {children}
        </>
    )
}
