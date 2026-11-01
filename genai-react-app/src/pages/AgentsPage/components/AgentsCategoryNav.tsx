import { Agent, AgentCategory, agentCategory } from '../../../models/agents.models'

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
