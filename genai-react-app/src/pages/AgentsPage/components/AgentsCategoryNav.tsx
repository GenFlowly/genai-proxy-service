import React from 'react'
import { useTranslation } from 'react-i18next'
import { AGENT_CATEGORIES, Agent, AgentCategory, agentCategory } from '../../../models/agents.models'
import styles from './AgentsCategoryNav.module.scss'

export type CategoryFilter = 'ALL' | AgentCategory

export const CATEGORY_LABEL_KEYS: Record<CategoryFilter, string> = {
    ALL: 'agentsPage.categories.all',
    CONVERSATION: 'agentsPage.categories.conversation',
    MEMORY: 'agentsPage.categories.memory',
    TITLE_CREATOR: 'agentsPage.categories.titleCreator',
    INSTRUCTIONS: 'agentsPage.categories.instructions',
}

const CATEGORY_ICONS: Record<CategoryFilter, string> = {
    ALL: '🗂️',
    CONVERSATION: '💬',
    MEMORY: '🧠',
    TITLE_CREATOR: '🏷️',
    INSTRUCTIONS: '📜',
}

interface AgentsCategoryNavProps {
    agents: Agent[]
    selected: CategoryFilter
    onSelect: (category: CategoryFilter) => void
}

/**
 * Category sections for the Agents page: a left sidebar on desktop, a
 * horizontally scrollable row of the same buttons on mobile (CSS switches the
 * layout — one code path). Follows the SettingsSidebar section-nav pattern.
 */
export default function AgentsCategoryNav({ agents, selected, onSelect }: AgentsCategoryNavProps) {
    const { t } = useTranslation()

    const countFor = (filter: CategoryFilter) =>
        filter === 'ALL' ? agents.length : agents.filter(a => agentCategory(a) === filter).length

    const filters: CategoryFilter[] = ['ALL', ...AGENT_CATEGORIES]

    return (
        <nav className={styles.nav} aria-label={t('agentsPage.categories.navAriaLabel')}>
            {filters.map(filter => (
                <button
                    key={filter}
                    type="button"
                    className={`${styles.navButton} ${selected === filter ? styles.active : ''}`}
                    onClick={() => onSelect(filter)}
                    aria-pressed={selected === filter}
                    data-testid={`agents-category-${filter.toLowerCase()}`}
                >
                    <span className={styles.icon} aria-hidden="true">{CATEGORY_ICONS[filter]}</span>
                    <span className={styles.label}>{t(CATEGORY_LABEL_KEYS[filter])}</span>
                    <span className={styles.count}>{countFor(filter)}</span>
                </button>
            ))}
        </nav>
    )
}
