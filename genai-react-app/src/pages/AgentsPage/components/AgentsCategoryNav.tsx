import React from 'react'
import { useTranslation } from 'react-i18next'
import { AGENT_CATEGORIES, Agent, AgentCategory, agentCategory } from '../../../models/agents.models'
import styles from './AgentsCategoryNav.module.scss'

export type CategoryFilter = AgentCategory

export const CATEGORY_LABEL_KEYS: Record<CategoryFilter, string> = {
    CONVERSATION: 'agentsPage.categories.conversation',
    MEMORY: 'agentsPage.categories.memory',
    TITLE_CREATOR: 'agentsPage.categories.titleCreator',
    INSTRUCTIONS: 'agentsPage.categories.instructions',
}

export const CATEGORY_ICONS: Record<CategoryFilter, string> = {
    CONVERSATION: '💬',
    MEMORY: '🧠',
    TITLE_CREATOR: '🏷️',
    INSTRUCTIONS: '📜',
}

/** Agents in [filter], for the category counts. */
export function categoryCount(agents: Agent[], filter: CategoryFilter): number {
    return agents.filter(a => agentCategory(a) === filter).length
}

interface AgentsCategoryNavProps {
    agents: Agent[]
    selected: CategoryFilter
    onSelect: (category: CategoryFilter) => void
}

/**
 * 📱 Mobile category picker: a horizontally scrollable chip row above the
 * tiles. On desktop the page renders the categories as a SidebarListPanel
 * inside the standard resizable left sidebar instead.
 */
export default function AgentsCategoryNav({ agents, selected, onSelect }: AgentsCategoryNavProps) {
    const { t } = useTranslation()

    const filters: CategoryFilter[] = AGENT_CATEGORIES

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
                    <span className={styles.count}>{categoryCount(agents, filter)}</span>
                </button>
            ))}
        </nav>
    )
}
