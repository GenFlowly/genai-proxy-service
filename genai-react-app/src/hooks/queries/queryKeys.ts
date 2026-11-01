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
