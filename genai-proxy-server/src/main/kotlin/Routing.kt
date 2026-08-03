package com.genflowly

import activity.registerOnboardCustomerRoutes
import com.genflowly.activity.registerStoreApiKeyRoutes
import com.genflowly.activity.registerCreateInstructionRoutes
import com.genflowly.activity.registerGenerateTextRoutes
import com.genflowly.activity.registerGenerateTextStreamRoutes
import com.genflowly.activity.registerGetTextGenerationModelsRoutes
import com.genflowly.activity.registerSaveAIConfigPreferencesRoutes
import com.genflowly.activity.registerStoreVectorDBConfigRoutes
import com.genflowly.activity.registerStoreSupabaseConfigRoutes
import com.genflowly.service.AIRequestService
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import service.AIRequestManager
import com.genflowly.service.CustomerProfileService
import com.genflowly.activity.registerGetAIUsageActivityRoutes
import com.genflowly.activity.registerGetConversationRoutes
import com.genflowly.activity.registerGetCustomerInstructionListRoutes
import com.genflowly.activity.registerGetInstructionVersionRoutes
import com.genflowly.activity.registerGetInstructionSharedUsersRoutes
import com.genflowly.activity.registerCreateConversationTitleRoutes
import com.genflowly.activity.registerGetCustomerConversationsPaginatedRoutes
import com.genflowly.activity.registerDeleteConversationRoutes
import com.genflowly.activity.registerUnarchiveConversationRoutes
import com.genflowly.activity.registerGraphNodeRoutes
import com.genflowly.activity.registerCustomerGraphRoutes
import com.genflowly.activity.registerToolCredentialsRoutes
import com.genflowly.activity.registerCustomerProfileSettingsRoutes
import com.genflowly.activity.registerSearchRoutes
import com.genflowly.service.ConversationService
import com.genflowly.service.AIModelsService
import com.genflowly.service.GraphService
import com.genflowly.activity.registerCreateInstructionShareRoutes
import com.genflowly.activity.registerCreateConversationShareRoutes
import com.genflowly.activity.registerGetConversationSharedUsersRoutes
import com.genflowly.activity.registerDeleteInstructionRoutes
import com.genflowly.activity.registerGetProfileRoutes
import com.genflowly.providers.DynamoDBProvider

object Routes {
    private const val API_V1 = "/api/v1"
    const val API_ROOT = "/"

    const val GENERATE_TEXT = "$API_V1/generate-text"
    const val GENERATE_TEXT_STREAM = "$API_V1/generate-text-stream"
    const val STORE_API_KEY = "$API_V1/store-api-key"
    const val STORE_VECTOR_DB_CONFIG = "$API_V1/store-vector-db-config"
    const val STORE_SUPABASE_CONFIG = "$API_V1/store-supabase-config"
    const val ONBOARD_CUSTOMER = "$API_V1/onboard"
    const val UPDATE_USERNAME = "$API_V1/profile/username"
    const val UPDATE_DISCOVERABILITY = "$API_V1/profile/discoverability"
    const val SEARCH_USERS = "$API_V1/users/search"
    const val GET_TEXT_GENERATION_MODELS = "$API_V1/models"
    const val SAVE_AI_CONFIG_PREFERENCES = "$API_V1/save-ai-config"
    const val GET_CONVERSATION = "$API_V1/chat"
    const val CREATE_INSTRUCTION = "$API_V1/instruction"
    const val CREATE_INSTRUCTION_SHARE = "$API_V1/instruction/share"
    const val GET_INSTRUCTION_SHARED_USERS = "$API_V1/instruction/{instructionId}/shared"
    const val DELETE_INSTRUCTION = "$API_V1/instruction/{instructionId}"
    const val GET_CUSTOMER_INSTRUCTIONS = "$API_V1/instructions"
    const val GET_CUSTOMER_INSTRUCTION_VERSION = "$API_V1/instruction"
    const val CREATE_CONVERSATION_TITLE = "$API_V1/conversation/title"
    const val CREATE_CONVERSATION_SHARE = "$API_V1/conversation/share"
    const val GET_CONVERSATION_SHARED_USERS = "$API_V1/conversation/{conversationId}/shared"
    const val GET_AI_USAGE = "$API_V1/message/usage"
    const val GET_CUSTOMER_CONVERSATIONS_PAGINATED = "$API_V1/conversations"
    const val DELETE_CONVERSATION = "$API_V1/conversation/{conversationId}"
    const val UNARCHIVE_CONVERSATION = "$API_V1/conversation/{conversationId}/unarchive"
    const val GET_PROFILE = "$API_V1/profile"

    const val GRAPH_NODES = "$API_V1/graph-nodes"
    const val GRAPH_NODE = "$API_V1/graph-nodes/{nodeId}"
    const val GRAPH_NODE_VERSIONS = "$API_V1/graph-nodes/{nodeId}/versions"
    const val GRAPH_NODE_ROLLBACK = "$API_V1/graph-nodes/{nodeId}/rollback/{version}"

    const val GRAPHS = "$API_V1/graphs"
    const val GRAPH = "$API_V1/graphs/{graphId}"
    const val GRAPH_VERSIONS = "$API_V1/graphs/{graphId}/versions"
    const val GRAPH_ROLLBACK = "$API_V1/graphs/{graphId}/rollback/{version}"

    const val TOOL_CREDENTIALS = "$API_V1/tool-credentials"
    const val TOOL_CREDENTIAL = "$API_V1/tool-credentials/{toolType}"
}




fun Application.configureRouting(
    aiRequestService: AIRequestService,
    aiRequestManager: AIRequestManager,
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService,
    aiModelsService: AIModelsService,
    graphService: GraphService,
    dynamoDBProvider: DynamoDBProvider,
) {
    routing {
        get(Routes.API_ROOT) {
            call.respondText("Hello World!")
        }

        registerGenerateTextRoutes(aiRequestManager, customerProfileService)
        registerGenerateTextStreamRoutes(aiRequestManager, customerProfileService)
        registerStoreApiKeyRoutes(customerProfileService, aiModelsService)
        registerStoreVectorDBConfigRoutes(customerProfileService)
        registerStoreSupabaseConfigRoutes(customerProfileService)
        registerOnboardCustomerRoutes(customerProfileService)
        registerGetTextGenerationModelsRoutes(aiModelsService, customerProfileService)
        registerSaveAIConfigPreferencesRoutes(customerProfileService)
        registerGetConversationRoutes(customerProfileService, conversationService)
        registerCreateInstructionRoutes(aiRequestManager, customerProfileService)
        registerCreateInstructionShareRoutes(customerProfileService)
        registerCreateConversationShareRoutes(customerProfileService, conversationService)
        registerGetConversationSharedUsersRoutes(customerProfileService, conversationService)
        registerDeleteInstructionRoutes(customerProfileService)
        registerGetCustomerInstructionListRoutes(customerProfileService)
        registerGetInstructionVersionRoutes(customerProfileService)
        registerGetInstructionSharedUsersRoutes(customerProfileService)
        registerCreateConversationTitleRoutes(aiRequestManager, customerProfileService)
        registerGetAIUsageActivityRoutes(conversationService, customerProfileService)
        registerGetCustomerConversationsPaginatedRoutes(customerProfileService, conversationService)
        registerDeleteConversationRoutes(customerProfileService, conversationService)
        registerUnarchiveConversationRoutes(customerProfileService, conversationService)
        registerGraphNodeRoutes(graphService, customerProfileService)
        registerCustomerGraphRoutes(graphService, customerProfileService)
        registerToolCredentialsRoutes(customerProfileService)
        
        registerCustomerProfileSettingsRoutes(dynamoDBProvider)
        registerSearchRoutes(dynamoDBProvider)
        registerGetProfileRoutes(dynamoDBProvider)
    }
}
