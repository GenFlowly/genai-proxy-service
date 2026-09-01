import React from 'react'
import { useTranslation } from 'react-i18next'
import { useLayout } from '../../../context/LayoutContext'
import { AppMenuContent } from './AppMenuContent'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import styles from './MobileMenuContent.module.scss'

/**
 * Navbar-attached variant of the mobile app menu (used on pages that still
 * render the Navbar on mobile). Page context (history, saved notes) lives in
 * the MobileMenu overlay on the revamped pages, so this shows the app menu
 * only.
 */
export const MobileMenuContent: React.FC = () => {
    const { t } = useTranslation()
    const { toggleLeftSidebar } = useLayout()

    return (
        <div className={styles.mobileMenu}>
            <div className={styles.header}>
                <h2>{t("layout.mobileMenu.menu")}</h2>
                <button onClick={toggleLeftSidebar} className={styles.closeButton} aria-label={t("layout.mobileMenu.close")}>
                    <Icon src={ICONS.ALT_ARROW_LEFT} size={20} />
                </button>
            </div>

            <AppMenuContent onNavigate={toggleLeftSidebar} />
        </div>
    )
}
