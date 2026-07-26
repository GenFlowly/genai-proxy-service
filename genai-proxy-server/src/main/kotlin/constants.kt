package com.genflowly

object DynamoDBConstants {
    const val CUSTOMER_PROFILE_TABLE = "CustomerProfile"
    const val SUB_PARTITION_KEY = "sub"
    const val CLIENT_SORT_KEY = "client"

    const val CUSTOMER_USAGE_TABLE = "CustomerAIUsage"
    const val USAGE_DATE_SORT_KEY = "usageDate"

    const val CUSTOMER_API_KEY_TABLE = "CustomerVendorApiKeys"
    const val CUSTOMER_ID_KEY = "customerId"
    const val AI_VENDOR_KEY = "aiVendor"

    const val CONVERSATION_TABLE = "Conversation"
    const val CONVERSATION_ID_KEY = "conversationId"
    const val CONVERSATION_CUSTOMER_GSI_KEY = "customerIdIndex"

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

    // Tool credentials — per-customer, per-toolType
    const val CUSTOMER_TOOL_CREDENTIALS_TABLE = "CustomerToolCredentials"
    const val TOOL_TYPE_KEY = "toolType"
    const val TOOL_AUTH_TYPE_KEY = "authType"
    const val TOOL_CREDENTIALS_KEY = "credentials"
}