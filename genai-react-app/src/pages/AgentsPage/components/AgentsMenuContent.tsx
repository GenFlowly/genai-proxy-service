import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Chip, Icon, SidebarWidget, sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import type { SidebarListGroup } from '@genflowly/component-library'
import MobileMenuBody from '../../../components/widgets/MobileMenuBody/MobileMenuBody'
import { ICONS } from '../../../constants/icons'
import { AGENT_CATEGORIES, Agent, agentCategory } from '../../../models/agents.models'
import { CATEGORY_LABEL_KEYS, CategoryFilter, categoryCount } from './AgentsCategoryNav'
import styles from '../AgentsPage.module.scss'

const CATEGORY_MENU_ICONS: Record<CategoryFilter, string> = {
    CONVERSATION: ICONS.CHAT_BUBBLE,
    MEMORY: ICONS.BRAIN,
    TITLE_CREATOR: ICONS.TAG,
    INSTRUCTIONS: ICONS.DOCUMENT_TEXT,
}

interface AgentsMenuContentProps {
    agents: Agent[]
    loading: boolean
    category: CategoryFilter
    ownership: 'all' | 'mine'
    onCategoryChange: (category: CategoryFilter) => void
    onOwnershipChange: (ownership: 'all' | 'mine') => void
    onAgentSelect: (agent: Agent) => void
}

/**
 * The Agents page's L2 Menu: categories above that category's agents. Search
 * filters by name across every category, since the API doesn't index agents.
 */
export default function AgentsMenuContent({
    agents,
    loading,
    category,
    ownership,
    onCategoryChange,
    onOwnershipChange,
    onAgentSelect,
}: AgentsMenuContentProps): React.ReactElement {
    const { t } = useTranslation()
    const [query, setQuery] = useState('')
    const normalizedQuery = query.trim().toLowerCase()

    const visibleAgents = useMemo(
        () => agents.filter(agent =>
            (ownership === 'all' || !agent.isSystem) &&
            (normalizedQuery
                ? agent.name.toLowerCase().includes(normalizedQuery)
                : agentCategory(agent) === category)
        ),
        [agents, category, ownership, normalizedQuery]
    )

    const categoryGroup: SidebarListGroup = {
        id: 'categories',
        label: t('agentsPage.categories.sectionLabel'),
        items: (AGENT_CATEGORIES as CategoryFilter[]).map(filter => ({
            id: filter,
            label: (
                <span className={styles.categoryItem}>
                    <Icon src={CATEGORY_MENU_ICONS[filter]} size={18} className={styles.categoryMenuIcon} />
                    <span className={styles.categoryItemLabel}>{t(CATEGORY_LABEL_KEYS[filter])}</span>
                    <span className={styles.categoryCount}>{categoryCount(agents, filter)}</span>
                </span>
            ),
            isActive: !normalizedQuery && category === filter,
            ariaCurrent: 'true' as const,
            onSelect: () => onCategoryChange(filter),
            testId: `agents-menu-category-${filter.toLowerCase()}`,
        })),
    }

    const agentsGroup: SidebarListGroup = {
        id: 'agents',
        label: t('agentsPage.menu.agents'),
        headerContent: (
            <span className={styles.menuChips}>
                <Chip
                    label={t('agentsPage.filters.allAgents')}
                    selected={ownership === 'all'}
                    onClick={() => onOwnershipChange('all')}
                    data-testid="agents-menu-filter-all"
                />
                <Chip
                    label={t('agentsPage.filters.createdByMe')}
                    selected={ownership === 'mine'}
                    onClick={() => onOwnershipChange('mine')}
                    data-testid="agents-menu-filter-mine"
                />
            </span>
        ),
        items: visibleAgents.map(agent => ({
            id: agent.graphId,
            label: agent.name,
            details: (
                <span className={panelStyles.timestamp}>
                    {t(agent.isSystem ? 'agentsPage.menu.systemReadOnly' : 'agentsPage.menu.createdByYou')}
                </span>
            ),
            onSelect: () => onAgentSelect(agent),
            testId: `agents-menu-agent-${agent.graphId}`,
        })),
    }

    return (
        <MobileMenuBody
            searchValue={query}
            onSearchChange={setQuery}
            searchPlaceholder={t('layout.mobileMenu.searchAgents')}
        >
            <SidebarWidget
                variant="directory"
                touch
                list={{
                    groups: [categoryGroup],
                    isLoading: loading,
                    hasError: false,
                    errorText: '',
                    emptyText: '',
                    listAriaLabel: t('agentsPage.categories.navAriaLabel'),
                    'data-testid': 'agents-category-panel-mobile',
                }}
            />
            <SidebarWidget
                variant="directory"
                touch
                list={{
                    groups: [agentsGroup],
                    isLoading: loading,
                    hasError: false,
                    errorText: '',
                    emptyText: '',
                    listAriaLabel: t('agentsPage.menu.agents'),
                    'data-testid': 'agents-list-panel-mobile',
                }}
            />
        </MobileMenuBody>
    )
}
