import React from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { SidebarWidget, SidebarListLoadMore, SidebarListPanel, sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useContentSearch } from '../../../hooks/queries/useContentSearch'
import { SearchDataType, SearchResultItem } from '../../../services/searchService'
import { isSearchNotConfigured, searchSetupMessageKey, searchSetupPath } from '../../../services/searchError'

interface MenuSearchResultsProps {
    query: string
    types: SearchDataType[]
    untitledLabel: string
    onSelect: (result: SearchResultItem) => void
    // Called after leaving for Settings, so the menu can close.
    onLeave: () => void
    // 'card': shows the card's material, as the chat page's widgets do
    surface?: 'panel' | 'card'
    // 'default': desktop row density, for a desktop sidebar
    variant?: 'default' | 'menu'
}

/** Results of the unified search API, listed in a card in the L2 Menu. */
export default function MenuSearchResults({
    query,
    types,
    untitledLabel,
    onSelect,
    onLeave,
    surface = 'panel',
    variant = 'menu',
}: MenuSearchResultsProps): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isSignedOut } = useAuth()
    const { data, isFetching, isError, error } = useContentSearch(query, types)
    const results = data ?? []
    const notConfigured = isSearchNotConfigured(error) ? error : null

    return (
        <SidebarWidget data-testid="menu-search-results">
            <SidebarListPanel
                variant={variant}
                surface={surface}
                groups={results.length > 0
                    ? [{
                        id: 'results',
                        label: t('layout.mobileMenu.searchResults'),
                        items: results.map(result => ({
                            id: result.key,
                            label: result.title?.trim() || untitledLabel,
                            details: <span className={panelStyles.timestamp}>{result.snippet}</span>,
                            onSelect: () => onSelect(result),
                            testId: `menu-search-result-${result.key}`,
                        })),
                    }]
                    : []}
                isLoading={!isSignedOut && (isFetching || (data === undefined && !isError))}
                hasError={isError}
                errorText={notConfigured
                    ? t(searchSetupMessageKey(notConfigured.reason))
                    : t('layout.mobileMenu.searchFailed')}
                emptyText={isSignedOut ? t('layout.mobileMenu.pleaseLogInFirst') : t('layout.mobileMenu.noSearchResults')}
                listAriaLabel={t('layout.mobileMenu.searchResults')}
                footer={notConfigured && !isFetching ? (
                    <SidebarListLoadMore
                        label={t('common.search.openSettings')}
                        onClick={() => {
                            navigate(searchSetupPath(notConfigured.reason))
                            onLeave()
                        }}
                        testId="menu-search-open-settings"
                    />
                ) : undefined}
            />
        </SidebarWidget>
    )
}
