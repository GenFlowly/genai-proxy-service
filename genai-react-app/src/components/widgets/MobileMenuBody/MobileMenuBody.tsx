import React from 'react'
import { useTranslation } from 'react-i18next'
import { MenuSearchField } from '@genflowly/component-library'
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

/** The L2 Menu's content area: the page's cards above the bottom search pill. */
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
                {children}
            </div>
            {results != null && <div className={styles.cards}>{results}</div>}
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
