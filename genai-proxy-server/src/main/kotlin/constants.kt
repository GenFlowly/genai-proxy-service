package com.genflowly

import kotlinx.serialization.Serializable

object DynamoDBConstants {
    const val CUSTOMER_PROFILE_TABLE = "CustomerProfile"
    const val SUB_PARTITION_KEY = "sub"
    const val CLIENT_SORT_KEY = "client"

    // Per-customer usage/cost rollup. usageDate (the sort key) is a composite
    // "{YYYY-MM-DD}#{category}#{dim2}#{dim3}" string, not a bare date — see
    // repository/UsageRollupRepository.kt for the full key scheme.
    const val CUSTOMER_USAGE_TABLE = "CustomerAIUsage"
    const val USAGE_DATE_SORT_KEY = "usageDate"
    const val USAGE_CATEGORY_KEY = "category"
    const val USAGE_VENDOR_KEY = "vendor"
    const val USAGE_DIM3_KEY = "dim3" // model | opType | searchDepth, depending on category

    // Admin-configurable per-unit rates for categories with no real per-request
    // vendor price (Vector DB ops, Web Search credits) — priced at READ time.
    // PK=category, SK=rateKey.
    const val USAGE_RATE_CARD_TABLE = "UsageRateCard"
    const val USAGE_RATE_KEY = "rateKey"
    const val USAGE_USD_RATE_KEY = "usdRate"

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

    // Per-customer, per-embedding-vendor list of models the customer's key can
    // actually embed (discovered by probing). PK = customerId, SK = vendor.
    const val CUSTOMER_EMBEDDING_MODELS_TABLE = "CustomerEmbeddingModels"


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
    // AgentCategory name (CONVERSATION|MEMORY|TITLE_CREATOR|INSTRUCTIONS); may be
    // absent on graphs created before categories — responses then derive it from
    // the request-agent map, else default CONVERSATION.
    const val GRAPH_CATEGORY_KEY = "category"
    const val CUSTOMER_GRAPHS_GSI_KEY = "customerIdIndex"

    // Owner (customerId attribute) of the admin-published default graph that
    // every customer without an own default graph falls back to: one graph,
    // edited in place via the admin panel; customer edits fork it into a
    // customer-owned copy.
    const val SYSTEM_GRAPH_OWNER = "System"

    // Shared versioning keys used by both CustomerGraphNodes and CustomerGraphs.
    // version=0 is always the current/live record; version=1,2,... are immutable history.
    const val VERSION_KEY = "version"
    const val LATEST_VERSION_KEY = "latestVersion"
    const val DELETED_AT_KEY = "deletedAt"
    const val ARCHIVED_AT_KEY = "archivedAt"
    const val PINNED_AT_KEY = "pinnedAt"
    // Distinct AI vendors that have answered in this conversation, denormalized
    // onto the Conversation row (String Set, ADDed on message write) so list
    // endpoints never have to read the Message table to render vendor badges.
    // Absent on rows created before denormalization — list reads lazily
    // backfill it from the messages.
    const val VENDORS_KEY = "vendors"
    // Sparse GSI (customerId, pinnedAt): contains exactly the pinned rows —
    // pinnedAt only exists while pinned — pre-sorted most-recently-pinned-first.
    const val CONVERSATION_PINNED_GSI_KEY = "pinnedIndex"
    // Sparse GSI (projectId, updatedAt), KEYS_ONLY: only project-assigned rows.
    const val CONVERSATION_PROJECT_GSI_KEY = "projectIndex"
    // Conversation this one was forked from (POST /conversation/fork). Never
    // removed or updated after creation; the sidebar uses it to draw the fork
    // tree. A dangling value (parent archived/deleted) renders the fork flat.
    const val PARENT_CONVERSATION_ID_KEY = "parentConversationId"
    // Points at the durable agent run currently generating this conversation's
    // reply (DURABLE_AGENTS_DBOS_PLAN §5.8) — set while a /runs stream is live so
    // a page reload can rediscover and reattach; cleared when the run ends.
    const val PENDING_RUN_ID_KEY = "pendingRunId"
    // Set of the durable runs currently generating this conversation's reply — one
    // per vendor, since a multi-vendor turn fans out to N concurrent /runs. A
    // String Set so parallel vendor requests ADD/DELETE their own entry atomically
    // (the single PENDING_RUN_ID_KEY above only kept the last writer). Each element
    // encodes responseMessageId, runId, vendor, model. Cleared per-run as each ends.
    const val PENDING_RUNS_KEY = "pendingRuns"

    // Tool credentials — per-customer, per-toolType
    const val CUSTOMER_TOOL_CREDENTIALS_TABLE = "CustomerToolCredentials"
    const val TOOL_TYPE_KEY = "toolType"
    const val TOOL_AUTH_TYPE_KEY = "authType"
    const val TOOL_CREDENTIALS_KEY = "credentials"
    // Plain-JSON NON-SECRET per-tool config (e.g. WEB_SEARCH's
    // max_searches_per_turn). Never encrypted; may exist without credentials.
    // Read by the retrieval-server's ToolCredentialResolver in the same
    // GetItem as the credentials.
    const val TOOL_SETTINGS_KEY = "settings"

    // Per-customer declarative HTTP tools. PK=customerId, SK=name (the
    // model-facing tool name), so per-customer name uniqueness is a schema
    // property. The row never contains a secret: credentialRef points at a
    // CustomerToolCredentials sort key, and the values stay encrypted there.
    const val CUSTOMER_TOOLS_TABLE = "CustomerTools"
    const val TOOL_NAME_KEY = "name"
    const val TOOL_DESCRIPTION_KEY = "description"
    const val TOOL_PARAMETERS_KEY = "parameters"
    const val TOOL_PROVIDER_KEY = "provider"
    const val TOOL_REQUEST_KEY = "request"
    const val TOOL_CREDENTIAL_REF_KEY = "credentialRef"
    const val TOOL_RESPONSE_TRANSFORM_KEY = "responseTransform"
    const val TOOL_STATUS_KEY = "status"
    const val TOOL_ORIGIN_KEY = "origin"
    const val TOOL_ORIGIN_REF_KEY = "originRef"
    const val TOOL_DISCOVERED_TOOLS_KEY = "discoveredTools"
    const val TOOL_LAST_DRY_RUN_AT_KEY = "lastDryRunAt"

    const val SHARED_INSTRUCTIONS_TABLE = "SharedInstructions"
    const val SHARED_WITH_CUSTOMER_ID_KEY = "sharedWithCustomerId"
    const val SHARED_BY_CUSTOMER_ID_KEY = "sharedByCustomerId"
    const val ENTITY_ROLE_KEY = "role"

    const val SHARED_CONVERSATIONS_TABLE = "SharedConversations"
    const val SHARED_CONVERSATIONS_GSI_KEY = "conversationIdIndex"

    // GSI on Conversation table keyed by conversationId only, enabling lookup
    // of a conversation without knowing its owner (needed for shared conversations).
    const val CONVERSATION_ID_GSI_KEY = "conversationIdIndex"

    // Instruction usage tracking
    const val INSTRUCTION_USAGE_TABLE = "InstructionUsage"
    const val INSTRUCTION_USAGE_COUNT_KEY = "usageCount"
    const val INSTRUCTION_LAST_USED_KEY = "lastUsedAt"

    // Deduplication set — ensures each (conversationId, instructionId) pair is
    // counted at most once per customer.
    const val INSTRUCTION_USAGE_SEEN_TABLE = "InstructionUsageSeen"
    const val INSTRUCTION_USAGE_SEEN_SORT_KEY = "convInstKey" // "<conversationId>#<instructionId>"
    // When the pair was first seen; rows written before 2026-11-06 have none.
    const val INSTRUCTION_USAGE_SEEN_AT_KEY = "seenAt"

    const val CUSTOMER_NOTES_TABLE = "CustomerNotes"
    const val NOTE_KEY = "noteKey"

    // Long-term memories learned about a customer from conversations and notes.
    // PK=customerId, SK=memoryId. Memory items use the "MEM#" sort-key prefix;
    // "META#CONV#<conversationId>" items carry per-conversation extraction
    // bookkeeping (debounce state) and never appear in listings.
    const val CUSTOMER_MEMORY_TABLE = "CustomerMemory"
    const val MEMORY_ID_KEY = "memoryId"
    const val MEMORY_ITEM_PREFIX = "MEM#"
    // A memory's immutable change log, "MEMCHG#<uuid>#<createdAt>#<suffix>",
    // and usage log, "MEMUSE#<uuid>#<turnStartedAt>#<messageId>" (written by
    // the retrieval server, which shares this key format). Neither prefix
    // matches "MEM#", so memory listings never see them.
    const val MEMORY_CHANGE_PREFIX = "MEMCHG#"
    const val MEMORY_USAGE_PREFIX = "MEMUSE#"
    // hitCount always equals the memory's number of usage rows: each row is
    // written and deleted in one transaction with its hit. lastUsedAt is the
    // newest row's usedAt.
    const val MEMORY_HIT_COUNT_KEY = "hitCount"
    const val MEMORY_LAST_USED_AT_KEY = "lastUsedAt"
    const val MEMORY_USED_AT_KEY = "usedAt"
    // Placement key for Profile in a memory's placements map; every other key
    // is a project id.
    const val MEMORY_PROFILE_PLACEMENT = "PROFILE"
    const val MEMORY_CONV_META_PREFIX = "META#CONV#"
    // Durable extraction work queue: one row per conversation awaiting an
    // extraction run/retry, drained by the reconciler via the sparse GSI
    // (only pending rows carry the constant pendingShard attribute).
    const val MEMORY_PENDING_PREFIX = "META#PENDING#"
    const val MEMORY_PENDING_SHARD_KEY = "pendingShard"
    const val MEMORY_PENDING_SHARD_VALUE = "PENDING"
    const val MEMORY_PENDING_DUE_AT_KEY = "dueAt"
    const val MEMORY_PENDING_INDEX = "pending-extraction-index"

    // Records saved but not (yet) in the customer's vector DB. PK=customerId,
    // SK="<type>#<key>". Rows scheduled for an embed retry carry the constant
    // retryShard, so the sparse retry-due-index holds exactly the due work.
    const val VECTOR_SYNC_PENDING_TABLE = "VectorSyncPending"
    const val VECTOR_SYNC_ITEM_KEY = "itemKey"
    const val VECTOR_SYNC_RETRY_SHARD_KEY = "retryShard"
    const val VECTOR_SYNC_RETRY_SHARD_VALUE = "RETRY"
    const val VECTOR_SYNC_DUE_AT_KEY = "dueAt"
    const val VECTOR_SYNC_RETRY_INDEX = "retry-due-index"

    // Deletions in progress, one row per account, conversation or note (PK
    // jobKey: "ACCOUNT#<customerId>", "CONVERSATION#<customerId>#<id>",
    // "NOTE#<customerId>#<noteKey>"). Pending jobs carry the constant
    // pendingShard, so the sparse pending-purge-index holds exactly the jobs
    // still to run.
    const val PURGE_JOBS_TABLE = "PurgeJobs"
    const val PURGE_JOBS_PENDING_INDEX = "pending-purge-index"
    // Customer-owned projects grouping conversations in the history sidebar.
    // PK=customerId, SK=projectId. Conversations reference a project via a
    // plain projectId attribute on their Conversation row (REMOVEd on project
    // delete — deleting a project never deletes its conversations).
    const val CUSTOMER_PROJECTS_TABLE = "CustomerProjects"
    const val PROJECT_ID_KEY = "projectId"
    const val PROJECT_NAME_KEY = "name"

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