import React from 'react'
import { useTranslation } from 'react-i18next'
import { MenuSearchField, SidebarStack } from '@genflowly/component-library'
import styles from './MobileMenuBody.module.scss'

interface MobileMenuBodyProps {
    searchValue: string
    onSearchChange: (value: string) => void
    searchPlaceholder: string
    /**
     * Shown instead of the children while searching. The children stay mounted
     * so clearing the search returns to the same scroll position and open rows.
     */
    results?: React.ReactNode
    children: React.ReactNode
}

/**
 * The L2 Menu's content area: the page's cards, each at its full height in one
 * column that scrolls as a whole, above the bottom search pill.
 */
export default function MobileMenuBody({
    searchValue,
    onSearchChange,
    searchPlaceholder,
    results,
    children,
}: MobileMenuBodyProps): React.ReactElement {
    const { t } = useTranslation()

    return (
        <>
            <div className={styles.cards} hidden={results != null} data-testid="mobile-menu-cards">
                <SidebarStack touch>{children}</SidebarStack>
            </div>
            {results != null && (
                <div className={styles.cards}>
                    <SidebarStack touch>{results}</SidebarStack>
                </div>
            )}
            <MenuSearchField
                value={searchValue}
                onChange={onSearchChange}
                placeholder={searchPlaceholder}
                clearLabel={t('layout.mobileMenu.clearSearch')}
                data-testid="mobile-menu-search"
            />
        </>
    )
}
