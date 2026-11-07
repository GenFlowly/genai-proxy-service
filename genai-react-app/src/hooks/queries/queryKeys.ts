/**
 * Query-key prefixes, in their own module so mutation call sites (services)
 * can invalidate without importing the hooks — hooks import services, so a
 * key living in a hook file would complete an import cycle.
 */
export const CUSTOMER_AGENTS_QUERY_KEY = 'customerAgents'
export const AGENT_DETAIL_QUERY_KEY = 'agentDetail'
export const PROFILE_QUERY_KEY = 'profile'
export const REQUEST_AGENTS_QUERY_KEY = 'requestAgents'
export const EMBEDDING_MODELS_QUERY_KEY = 'embeddingModels'
export const PROVIDER_CATALOG_QUERY_KEY = 'providerCatalog'
export const TEXT_GEN_MODELS_QUERY_KEY = 'textGenModels'
export const MEMORIES_QUERY_KEY = 'memories'
export const MEMORY_DETAIL_QUERY_KEY = 'memoryDetail'
export const MEMORY_USAGE_QUERY_KEY = 'memoryUsage'
export const INSTRUCTION_USAGE_QUERY_KEY = 'instructionUsage'
export const INSTRUCTION_SHARES_QUERY_KEY = 'instructionShares'
export const PROJECTS_QUERY_KEY = 'projects'
