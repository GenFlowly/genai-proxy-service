/**
 * Single builder for every per-customer localStorage key: all user data
 * persisted on this machine must be keyed `${customerId}_<suffix>` and built
 * through customerKey(), so per-customer data is greppable and attributable.
 * Logout wipes ALL of localStorage regardless (AuthContext.logout) — this
 * convention is defense-in-depth, not the cleanup mechanism.
 *
 * Deliberately global keys, exempt from the convention (no user data):
 * - 'customerId'               — owner marker for the active session
 * - 'theme'                    — device display preference; the one logout survivor
 * - 'provider_catalog_cache'   — platform-wide vendor catalog, identical for all customers
 * - 'i18nextLng'               — written by i18next's language detector
 * - UI layout preferences written via component-library storageKey props:
 *   'conversation_history_split_fraction', 'conversation_history_width_rem',
 *   'settings_sidebar_width_rem', 'saved_notes_width_rem',
 *   'agentsCategorySidebarWidth'
 *
 * External writer bound to this convention: component-library Request.tsx
 * builds `${customerId}_prompt_editor_content_conv-<blockId>` draft keys
 * itself — StorageSuffix.promptEditorContentPrefix must stay in sync with it.
 */
export function customerKey(customerId: string, suffix: string): string {
    return `${customerId}_${suffix}`
}

export const StorageSuffix = {
    aiPreferences: 'ai_preferences',
    vendorApiKeyStatuses: 'vendor_api_key_statuses',
    instructions: 'instructions',
    systemPrompt: 'system_prompt',
    selectedInstructionId: 'selected_instruction_id',
    selectedAgentId: 'selected_agent_id',
    aiVendorModels: 'ai_vendor_models',
    promptEditorContentPrefix: 'prompt_editor_content_',
    conversationHistory: 'conversation_history_cache_v1',
    savedNotes: 'saved_notes_cache_v1',
    recentInstructions: 'recent_instructions_cache_v1',
    requestAgents: 'request_agents_cache',
    customerAgents: 'customer_agents_cache',
    embeddingModels: 'embedding_models_cache',
    cacheVersions: 'cache_versions',
} as const
