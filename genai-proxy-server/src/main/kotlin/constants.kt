package com.genflowly

import kotlinx.serialization.Serializable

object DynamoDBConstants {
    const val CUSTOMER_PROFILE_TABLE = "CustomerProfile"
    const val SUB_PARTITION_KEY = "sub"
    const val CLIENT_SORT_KEY = "client"

    const val CUSTOMER_USAGE_TABLE = "CustomerAIUsage"
    const val USAGE_DATE_SORT_KEY = "usageDate"

    const val CUSTOMER_API_KEY_TABLE = "CustomerVendorApiKeys"
    const val CUSTOMER_ID_KEY = "customerId"
    const val AI_VENDOR_KEY = "aiVendor"

    // System-wide (not per-customer) AI vendor API keys, managed from the
    // admin panel. PK=aiVendor so retrieval is a single O(1) GetItem.
    const val SYSTEM_VENDOR_API_KEY_TABLE = "SystemVendorApiKeys"

    // Per-model metadata (token limits) refreshed daily from the vendors'
    // model APIs using the system keys. PK=aiVendor, SK=model.
    const val AI_MODEL_CATALOG_TABLE = "AIModelCatalog"
    const val MODEL_SORT_KEY = "model"

    const val CUSTOMER_DEVELOPER_API_KEY_TABLE = "CustomerDeveloperApiKeys"
    const val DEVELOPER_API_KEY_HASH_KEY = "keyHash"
    const val DEVELOPER_API_KEY_CUSTOMER_GSI = "customerIdIndex"

    const val CONVERSATION_TABLE = "Conversation"
    const val CONVERSATION_ID_KEY = "conversationId"
    const val CONVERSATION_CUSTOMER_GSI_KEY = "customerIdIndexV2"
    const val CONVERSATION_CUSTOMER_UPDATED_GSI_KEY = "customerIdUpdatedAtIndex"

    const val MESSAGE_TABLE = "Message"
    const val MESSAGE_ID_SORT_KEY = "messageId"

    const val CUSTOMER_PREFERENCES_TABLE = "CustomerPreferences"
    
    const val CUSTOMER_VECTOR_DB_CONFIG_TABLE = "CustomerVectorDBConfig"
    const val VENDOR_KEY = "vendor"


    const val INSTRUCTION_TABLE = "Instructions"
    const val INSTRUCTION_ID_KEY = "instructionId"
    const val INSTRUCTION_CREATOR_KEY = "creator"
    const val INSTRUCTION_NAME_KEY = "name"
    const val INSTRUCTION_CONTENT_KEY = "instructions"
    const val INSTRUCTION_VERSION_KEY = "version"
    const val INSTRUCTION_ICON_KEY = "icon"
    const val INSTRUCTION_COLOR_KEY = "color"
    const val INSTRUCTION_TAGS_KEY = "tags"
    const val INSTRUCTION_CATEGORY_KEY = "category"
    const val INSTRUCTION_CREATOR_GSI_KEY = "creatorIndexV2"

    const val CUSTOMER_GRAPH_NODES_TABLE = "CustomerGraphNodes"
    const val NODE_ID_KEY = "nodeId"
    const val NODE_TYPE_KEY = "nodeType"
    const val NODE_NAME_KEY = "name"
    const val NODE_CONFIG_KEY = "config"
    const val CUSTOMER_GRAPH_NODES_GSI_KEY = "customerIdIndex"

    const val CUSTOMER_GRAPHS_TABLE = "CustomerGraphs"
    const val GRAPH_ID_KEY = "graphId"
    const val GRAPH_NAME_KEY = "name"
    const val GRAPH_IS_DEFAULT_KEY = "isDefault"
    const val GRAPH_NODE_IDS_KEY = "nodeIds"
    const val GRAPH_EDGES_KEY = "edges"
    const val GRAPH_ENTRY_POINT_KEY = "entryPoint"
    const val GRAPH_MAX_ITERATIONS_KEY = "maxIterations"
    // Editor canvas layout: JSON {"positions":{"<nodeId>":{"x":n,"y":n}}}. Purely
    // presentational — never read by the graph runtime.
    const val GRAPH_LAYOUT_KEY = "layout"
    const val CUSTOMER_GRAPHS_GSI_KEY = "customerIdIndex"

    // Owner (customerId attribute) of the admin-published default graph that
    // every customer without an own default graph falls back to. Mirrors
    // SYSTEM_INSTRUCTION_CREATOR: one graph, edited in place via the admin
    // panel; customer edits fork it into a customer-owned copy.
    const val SYSTEM_GRAPH_OWNER = "System"

    // Shared versioning keys used by both CustomerGraphNodes and CustomerGraphs.
    // version=0 is always the current/live record; version=1,2,... are immutable history.
    const val VERSION_KEY = "version"
    const val LATEST_VERSION_KEY = "latestVersion"
    const val DELETED_AT_KEY = "deletedAt"
    const val ARCHIVED_AT_KEY = "archivedAt"
    const val PINNED_AT_KEY = "pinnedAt"
    // Points at the durable agent run currently generating this conversation's
    // reply (DURABLE_AGENTS_DBOS_PLAN §5.8) — set while a /runs stream is live so
    // a page reload can rediscover and reattach; cleared when the run ends.
    const val PENDING_RUN_ID_KEY = "pendingRunId"

    // Tool credentials — per-customer, per-toolType
    const val CUSTOMER_TOOL_CREDENTIALS_TABLE = "CustomerToolCredentials"
    const val TOOL_TYPE_KEY = "toolType"
    const val TOOL_AUTH_TYPE_KEY = "authType"
    const val TOOL_CREDENTIALS_KEY = "credentials"

    const val SHARED_INSTRUCTIONS_TABLE = "SharedInstructions"
    const val SHARED_WITH_CUSTOMER_ID_KEY = "sharedWithCustomerId"
    const val SHARED_BY_CUSTOMER_ID_KEY = "sharedByCustomerId"
    const val ENTITY_ROLE_KEY = "role"

    const val SHARED_CONVERSATIONS_TABLE = "SharedConversations"
    const val SHARED_CONVERSATIONS_GSI_KEY = "conversationIdIndex"

    // GSI on Conversation table keyed by conversationId only, enabling lookup
    // of a conversation without knowing its owner (needed for shared conversations).
    const val CONVERSATION_ID_GSI_KEY = "conversationIdIndex"

    // Creator value marking the single global default instruction, managed via
    // the admin panel. It keeps one instruction id whose version increases; the
    // latest version is the default used when a customer selects none.
    const val SYSTEM_INSTRUCTION_CREATOR = "System"

    // Instruction usage tracking
    const val INSTRUCTION_USAGE_TABLE = "InstructionUsage"
    const val INSTRUCTION_USAGE_COUNT_KEY = "usageCount"
    const val INSTRUCTION_LAST_USED_KEY = "lastUsedAt"

    // Deduplication set — ensures each (conversationId, instructionId) pair is
    // counted at most once per customer.
    const val INSTRUCTION_USAGE_SEEN_TABLE = "InstructionUsageSeen"
    const val INSTRUCTION_USAGE_SEEN_SORT_KEY = "convInstKey" // "<conversationId>#<instructionId>"

    const val CUSTOMER_NOTES_TABLE = "CustomerNotes"
    const val NOTE_KEY = "noteKey"

    // Long-term memories learned about a customer from conversations and notes.
    // PK=customerId, SK=memoryId. Memory items use the "MEM#" sort-key prefix;
    // "META#CONV#<conversationId>" items carry per-conversation extraction
    // bookkeeping (debounce state) and never appear in listings.
    const val CUSTOMER_MEMORY_TABLE = "CustomerMemory"
    const val MEMORY_ID_KEY = "memoryId"
    const val MEMORY_ITEM_PREFIX = "MEM#"
    const val MEMORY_CONV_META_PREFIX = "META#CONV#"

    // Username reservation/lookup — PK=username; recordTypeIndex GSI supports
    // prefix search across USER records.
    const val USERNAME_LOOKUP_TABLE = "UsernameLookup"
    const val USERNAME_KEY = "username"
    const val USERNAME_RECORD_TYPE_KEY = "recordType"
    const val USERNAME_RECORD_TYPE_GSI = "recordTypeIndex"

    // GSI on CustomerProfile keyed by customerId (profiles are stored under sub+client).
    const val CUSTOMER_PROFILE_CUSTOMER_ID_GSI = "customerIdIndex"

    // GSI on SharedInstructions keyed by instructionId (who is an entity shared with).
    const val SHARED_INSTRUCTIONS_GSI_KEY = "instructionIdIndex"

    // Admin-curated pre-made nodes for the graph editor palette. PK=presetId.
    // Attributes: name, nodeType, description, config (JSON string),
    // requiredAttributes (list<string>), sortOrder (number).
    const val NODE_PRESETS_TABLE = "NodePresets"
    const val PRESET_ID_KEY = "presetId"
    const val PRESET_NAME_KEY = "name"
    const val PRESET_NODE_TYPE_KEY = "nodeType"
    const val PRESET_DESCRIPTION_KEY = "description"
    const val PRESET_CONFIG_KEY = "config"
    const val PRESET_REQUIRED_ATTRIBUTES_KEY = "requiredAttributes"
    const val PRESET_SORT_ORDER_KEY = "sortOrder"

    // Request-type → agent-graph mapping. PK=scope ("SYSTEM" for global
    // defaults, a customerId for future per-customer overrides), SK=requestType.
    const val REQUEST_AGENT_MAP_TABLE = "RequestAgentMap"
    const val REQUEST_AGENT_SCOPE_KEY = "scope"
    const val REQUEST_AGENT_REQUEST_TYPE_KEY = "requestType"
    const val REQUEST_AGENT_MAP_KEY = "mapKey"
    const val REQUEST_AGENT_GRAPH_ID_KEY = "graphId"
    const val REQUEST_AGENT_ENABLED_KEY = "enabled"
    const val REQUEST_AGENT_UPDATED_BY_KEY = "updatedBy"
}

// Custom response headers forming part of the API contract. Every header
// added here must also be exposed via exposeHeader() in the CORS config
// (Application.kt), or browser clients cannot read it.
object ResponseHeaders {
    const val CONVERSATION_ID = "X-Conversation-Id"
    const val MESSAGE_ID = "X-Message-Id"
    const val RESPONSE_MESSAGE_ID = "X-Response-Message-Id"
    const val AI_VENDOR = "X-Ai-Vendor"
    const val INSTRUCTION_ID = "X-Instruction-Id"
    const val INSTRUCTION_VERSION = "X-Instruction-Version"

    // Nginx/proxy hint disabling response buffering for streamed responses.
    // Not part of the client-facing contract, so not CORS-exposed.
    const val ACCEL_BUFFERING = "X-Accel-Buffering"
}

// Scope value in RequestAgentMap for the global default mappings. The agents
// and instructions those mappings reference are ordinary customer-owned
// resources (owned by the mapping admin's account).
const val SYSTEM_SCOPE = "SYSTEM"

// Platform-standard embedding model, sent explicitly on every encoding-server
// call. Collection creation and note encoding must agree on this: the model
// fixes the vector dimension baked into the Milvus collection schema, and
// retrieval resolves the query encoder from the collection's stored metadata.
object EmbeddingConstants {
    const val MODEL_TYPE = "voyage"
    const val MODEL_NAME = "voyage-4-large"

    /**
     * Provider ("model_type") for an embedding model name. The customer
     * preference stores only the model name (AIConfigPreferences.embeddingModel),
     * so callers derive the provider from the vendor's naming convention —
     * voyage-* is Voyage, text-embedding-* is OpenAI.
     */
    fun modelTypeFor(modelName: String?): String = when {
        modelName == null -> MODEL_TYPE
        modelName.startsWith("voyage") -> "voyage"
        modelName.startsWith("text-embedding") -> "openai"
        else -> MODEL_TYPE
    }
}

// Node type of a locally-executed single-LLM-call graph node whose config
// references the instruction (system prompt) to use.
const val GENERATION_NODE_TYPE = "GENERATION"
@Serializable
data class PersonaCategory(
    val categoryName: String,
    val baseIcon: String,
    val baseColor: String
)

val PERSONA_CATEGORIES = listOf(
    PersonaCategory("Writing/editing", "🖊️", "#4F46E5"), // Indigo
    PersonaCategory("Research", "🔍", "#059669"), // Emerald
    PersonaCategory("Coding", "💻", "#2563EB"), // Blue
    PersonaCategory("Planning", "📅", "#D97706"), // Amber
    PersonaCategory("Analysis", "📊", "#7C3AED"), // Violet
    PersonaCategory("Teaching", "📚", "#0891B2"), // Cyan
    PersonaCategory("Creative ideation", "✨", "#DB2777"), // Pink
    PersonaCategory("Security/compliance", "🛡️", "#DC2626"), // Red
    PersonaCategory("Customer support", "🎧", "#65A30D"), // Lime
    PersonaCategory("Data work", "🗄️", "#475569")  // Slate
)