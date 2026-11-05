import React from 'react'
import { useTranslation } from 'react-i18next'
import { SidebarCard, SidebarListPanel, sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import { useContentSearch } from '../../../hooks/queries/useContentSearch'
import { SearchDataType, SearchResultItem } from '../../../services/searchService'

interface MenuSearchResultsProps {
    query: string
    types: SearchDataType[]
    untitledLabel: string
    onSelect: (result: SearchResultItem) => void
}

/** Results of the unified search API, listed in a card in the L2 Menu. */
export default function MenuSearchResults({
    query,
    types,
    untitledLabel,
    onSelect,
}: MenuSearchResultsProps): React.ReactElement {
    const { t } = useTranslation()
    const { data, isFetching, isError } = useContentSearch(query, types)
    const results = data ?? []

    return (
        <SidebarCard data-testid="menu-search-results">
            <SidebarListPanel
                variant="menu"
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
                isLoading={isFetching || (data === undefined && !isError)}
                hasError={isError}
                errorText={t('layout.mobileMenu.searchFailed')}
                emptyText={t('layout.mobileMenu.noSearchResults')}
                listAriaLabel={t('layout.mobileMenu.searchResults')}
            />
        </SidebarCard>
    )
}
