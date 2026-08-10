import React, { useLayoutEffect, useState } from 'react'
import PillButton from '../../common/PillButton/PillButton'
// Deliberately reuses the sidebar stylesheet so the modal inherits its look
import styles from './RightSidebar.module.scss'

interface RightSidebarMobileModalProps {
    children: React.ReactNode
    onClose: () => void
    'data-testid'?: string
}

/**
 * Mobile view of the right sidebar: a modal rendered on the same page
 * (same URL, same React tree), so its widgets keep full access to the
 * page's contexts and can interact with the page state.
 * Covers everything below the navbar — the navbar itself stays visible.
 */
export default function RightSidebarMobileModal({ children, onClose, 'data-testid': testId }: RightSidebarMobileModalProps): React.ReactElement {
    // Pin the modal directly below the navbar, whatever its rendered height is
    const [topOffset, setTopOffset] = useState(0)

    useLayoutEffect(() => {
        const measure = () => {
            const nav = document.querySelector('nav')
            setTopOffset(nav ? Math.max(0, nav.getBoundingClientRect().bottom) : 0)
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
    }, [])

    return (
        <div
            className={styles.mobileModal}
            style={{ top: topOffset }}
            role="dialog"
            aria-modal="true"
            aria-label="AI Settings"
            data-testid={testId || 'right-sidebar-mobile-modal'}
        >
            <div className={styles.sidebarContent}>
                {children}
            </div>
            <div className={styles.mobileFooter}>
                <PillButton
                    label="Close Settings"
                    variant="secondary"
                    onClick={onClose}
                    className={styles.closeSettingsButton}
                    data-testid="right-sidebar-close"
                />
            </div>
        </div>
    )
}
