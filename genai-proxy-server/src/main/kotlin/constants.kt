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

    const val MESSAGE_TABLE = "Message"
    const val MESSAGE_ID_SORT_KEY = "messageId"

    const val CUSTOMER_PREFERENCES_TABLE = "CustomerPreferences"
    
    const val CUSTOMER_VECTOR_DB_CONFIG_TABLE = "CustomerVectorDBConfig"
    const val VENDOR_KEY = "vendor"

    const val CUSTOMER_SUPABASE_CONFIG_TABLE = "CustomerSupabaseConfig"

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
    const val CUSTOMER_GRAPHS_GSI_KEY = "customerIdIndex"

    // Shared versioning keys used by both CustomerGraphNodes and CustomerGraphs.
    // version=0 is always the current/live record; version=1,2,... are immutable history.
    const val VERSION_KEY = "version"
    const val LATEST_VERSION_KEY = "latestVersion"
    const val DELETED_AT_KEY = "deletedAt"
    const val ARCHIVED_AT_KEY = "archivedAt"

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