import { config } from './env';

const BASE = config.backend.baseUrl;
const API_PREFIX = '/api/v1';

export const endpoints = {
    onboardCustomer: `${BASE}${API_PREFIX}/onboard`,
    storeCustomerVendorApiKey: `${BASE}${API_PREFIX}/store-api-key`,
    storeCustomerVendorConfig: `${BASE}${API_PREFIX}/store-vendor-config`,
    getEmbeddingKeys: `${BASE}${API_PREFIX}/embedding-keys`,
    deleteEmbeddingKey: (vendor: string) => `${BASE}${API_PREFIX}/embedding-keys/${encodeURIComponent(vendor)}`,
    storeEmbeddingKey: `${BASE}${API_PREFIX}/store-embedding-key`,
    getEmbeddingModels: `${BASE}${API_PREFIX}/embedding-models`,
    storeCustomerVectorDBConfig: `${BASE}${API_PREFIX}/store-vector-db-config`,
    generateText: `${BASE}${API_PREFIX}/generate-text`,
    generateTextStream: `${BASE}${API_PREFIX}/generate-text-stream`,
    cancelGeneration: (responseMessageId: string) => `${BASE}${API_PREFIX}/generations/cancel?responseMessageId=${encodeURIComponent(responseMessageId)}`,
    // Durable-run reattach (reload recovery) + resume (human-in-the-loop reply).
    reattachRun: (runId: string, conversationId: string, fromSeq = 0) =>
        `${BASE}${API_PREFIX}/runs/${encodeURIComponent(runId)}/stream?conversationId=${encodeURIComponent(conversationId)}&fromSeq=${fromSeq}`,
    resumeRun: (runId: string, conversationId: string) =>
        `${BASE}${API_PREFIX}/runs/${encodeURIComponent(runId)}/resume?conversationId=${encodeURIComponent(conversationId)}`,
    getTextGenerationModels: `${BASE}${API_PREFIX}/models`,
    getProviders: `${BASE}${API_PREFIX}/providers`,
    saveAIConfig: `${BASE}${API_PREFIX}/save-ai-config`,
    createInstruction: `${BASE}${API_PREFIX}/instruction`,
    instructionUsage: (instructionId: string) => `${BASE}${API_PREFIX}/instruction/${encodeURIComponent(instructionId)}/usage`,
    getCustomerInstructions: `${BASE}${API_PREFIX}/instructions`,
    searchInstructions: `${BASE}${API_PREFIX}/instructions/search`,
    search: `${BASE}${API_PREFIX}/search`,
    getRecentInstructions: `${BASE}${API_PREFIX}/instructions/recent`,
    createConversationTitle: `${BASE}${API_PREFIX}/conversation/title`,
    conversationShare: `${BASE}${API_PREFIX}/conversation/share`,
    conversationSharedUsers: (conversationId: string) => `${BASE}${API_PREFIX}/conversation/shared?conversationId=${encodeURIComponent(conversationId)}`,
    getCustomerConversations: `${BASE}${API_PREFIX}/conversations`,
    deleteConversation: (conversationId: string) => `${BASE}${API_PREFIX}/conversation/${conversationId}`,
    getPinnedConversations: `${BASE}${API_PREFIX}/conversations/pinned`,
    pinConversation: (conversationId: string) => `${BASE}${API_PREFIX}/conversation/pin?conversationId=${encodeURIComponent(conversationId)}`,
    unpinConversation: (conversationId: string) => `${BASE}${API_PREFIX}/conversation/unpin?conversationId=${encodeURIComponent(conversationId)}`,
    forkConversation: (conversationId: string, messageId: string) =>
        `${BASE}${API_PREFIX}/conversation/fork?conversationId=${encodeURIComponent(conversationId)}&messageId=${encodeURIComponent(messageId)}`,
    getProjects: `${BASE}${API_PREFIX}/projects`,
    getProjectConversations: `${BASE}${API_PREFIX}/projects/conversations`,
    createProject: `${BASE}${API_PREFIX}/project`,
    assignConversationProject: (conversationId: string, projectId: string) =>
        `${BASE}${API_PREFIX}/conversation/assign-project?conversationId=${encodeURIComponent(conversationId)}&projectId=${encodeURIComponent(projectId)}`,
    unassignConversationProject: (conversationId: string) =>
        `${BASE}${API_PREFIX}/conversation/unassign-project?conversationId=${encodeURIComponent(conversationId)}`,
    getAIUsage: `${BASE}${API_PREFIX}/message/usage`,
    // Cost and Usage settings pages — aggregate per-customer summaries over a date range.
    // usageLlm and usageEmbedding are live; usageVectorDb/usageWebSearch 404 until their
    // instrumentation phases land (the frontend treats that as "not tracked yet", not an
    // error — see getUsageService.ts).
    usageLlm: (from: string, to: string) =>
        `${BASE}${API_PREFIX}/usage/llm?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    usageEmbedding: (from: string, to: string) =>
        `${BASE}${API_PREFIX}/usage/embedding?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    usageVectorDb: (from: string, to: string) =>
        `${BASE}${API_PREFIX}/usage/vector-db?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    usageWebSearch: (from: string, to: string) =>
        `${BASE}${API_PREFIX}/usage/web-search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    searchUsers: `${BASE}${API_PREFIX}/users/search`,
    getProfile: `${BASE}${API_PREFIX}/profile`,
    updateUsername: `${BASE}${API_PREFIX}/profile/username`,
    updateDiscoverability: `${BASE}${API_PREFIX}/profile/discoverability`,
    completeOnboarding: `${BASE}${API_PREFIX}/profile/onboarding-completed`,
    getCustomerAgents: `${BASE}${API_PREFIX}/agents`,
    getRequestAgents: `${BASE}${API_PREFIX}/request-agents`,
    requestAgentMapping: (requestType: string) => `${BASE}${API_PREFIX}/request-agents/${requestType}`,
    getAgent: (graphId: string) => `${BASE}${API_PREFIX}/agents/${graphId}`,
    forkAgent: (graphId: string) => `${BASE}${API_PREFIX}/agents/${graphId}/fork`,
    createAgentGraph: `${BASE}${API_PREFIX}/agents/graph`,
    getNodePresets: `${BASE}${API_PREFIX}/node-presets`,
    customerTools: `${BASE}${API_PREFIX}/tools`,
    customerTool: (name: string) => `${BASE}${API_PREFIX}/tools/${encodeURIComponent(name)}`,
    customerToolDryRun: (name: string) => `${BASE}${API_PREFIX}/tools/${encodeURIComponent(name)}/dry-run`,
    toolCredentials: `${BASE}${API_PREFIX}/tool-credentials`,
    toolCredential: (toolType: string) => `${BASE}${API_PREFIX}/tool-credentials/${encodeURIComponent(toolType)}`,
    connectors: `${BASE}${API_PREFIX}/connectors`,
    connector: (id: string) => `${BASE}${API_PREFIX}/connectors/${encodeURIComponent(id)}`,
    connectorOpenApiPreview: `${BASE}${API_PREFIX}/connectors/openapi/preview`,
    connectorOpenApiImport: `${BASE}${API_PREFIX}/connectors/openapi/import`,
    connectorMcpDiscover: `${BASE}${API_PREFIX}/connectors/mcp/discover`,
    connectorMcpConnect: `${BASE}${API_PREFIX}/connectors/mcp/connect`,
    developerApiKeys: `${BASE}${API_PREFIX}/developer/api-keys`,
    developerApiKey: (keyId: string) => `${BASE}${API_PREFIX}/developer/api-keys/${keyId}`,
    attachments: `${BASE}${API_PREFIX}/attachments`,
    attachmentUrl: (attachmentId: string) => `${BASE}${API_PREFIX}/attachments/url?attachmentId=${encodeURIComponent(attachmentId)}`,
    getLearnedFacts: (conversationId: string, messageId: string) => `${BASE}${API_PREFIX}/conversation/learned-facts?conversationId=${encodeURIComponent(conversationId)}&messageId=${encodeURIComponent(messageId)}`,
    // Memory ids look like "MEM#<uuid>": the "#" must be encoded, or the
    // browser drops the rest of the id as a URL fragment.
    memories: `${BASE}${API_PREFIX}/memories`,
    memory: (memoryId: string) => `${BASE}${API_PREFIX}/memories/${encodeURIComponent(memoryId)}`,
    moveMemory: (memoryId: string) => `${BASE}${API_PREFIX}/memories/${encodeURIComponent(memoryId)}/move`,
    copyMemory: (memoryId: string) => `${BASE}${API_PREFIX}/memories/${encodeURIComponent(memoryId)}/copy`,
    memoryUsage: (memoryId: string) => `${BASE}${API_PREFIX}/memories/${encodeURIComponent(memoryId)}/usage`,
    deleteAccount: `${BASE}${API_PREFIX}/account`,
    deleteAllCredentials: `${BASE}${API_PREFIX}/credentials`,
    indexedChats: `${BASE}${API_PREFIX}/indexing/chats`,
};
