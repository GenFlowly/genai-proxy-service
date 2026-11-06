/**
 * Single builder for every per-customer localStorage key: all user data
 * persisted on this machine must be keyed `${customerId}_<suffix>` and built
 * through customerKey(), so per-customer data is greppable and attributable.
 * Logout wipes ALL of localStorage regardless (AuthContext.logout) — this
 * convention is defense-in-depth, not the cleanup mechanism.
 *
 * NEVER persist credentials or credential-adjacent data to localStorage:
 * vendor API keys, key STATUSES, Zilliz/vector-DB config, Tavily/tool
 * credentials, embedding keys. Those live in React state only and repopulate
 * from the server each session.
 *
 * Deliberately global keys, exempt from the convention (no user data):
 * - 'customerId'               — owner marker for the active session
 * - 'theme'                    — device display preference; the one logout survivor
 * - 'provider_catalog_cache'   — platform-wide vendor catalog, identical for all customers
 * - 'i18nextLng'               — written by i18next's language detector
 * - UI layout preferences written via component-library storageKey props:
 *   'conversation_history_split_fraction', 'conversation_history_width_rem',
 *   'settings_sidebar_width_rem', 'memory_sidebar_width_rem',
 *   'agentsCategorySidebarWidth'
 *
 * Leftovers only: component-library Request.tsx before 0.1.125 kept
 * `${customerId}_prompt_editor_content_conv-<blockId>` drafts. Nothing reads or
 * writes them now; New Chat still sweeps them (StorageSuffix.promptEditorContentPrefix)
 * because they hold prompt text.
 */
export function customerKey(customerId: string, suffix: string): string {
    return `${customerId}_${suffix}`
}

export const StorageSuffix = {
    aiPreferences: 'ai_preferences',
    instructions: 'instructions',
    profile: 'profile_cache_v1',
    systemPrompt: 'system_prompt',
    selectedInstructionId: 'selected_instruction_id',
    selectedAgentId: 'selected_agent_id',
    aiVendorModels: 'ai_vendor_models',
    promptEditorContentPrefix: 'prompt_editor_content_',
    conversationHistory: 'conversation_history_cache_v1',
    memories: 'memories_cache_v1',
    recentInstructions: 'recent_instructions_cache_v1',
    requestAgents: 'request_agents_cache',
    customerAgents: 'customer_agents_cache',
    embeddingModels: 'embedding_models_cache',
    cacheVersions: 'cache_versions',
} as const
