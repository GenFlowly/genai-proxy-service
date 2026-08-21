package com.genflowly

import com.genflowly.activity.agent.registerGetCustomerAgentsRoutes
import com.genflowly.activity.agent.registerUpdateAgentRoutes
import com.genflowly.activity.conversation.registerCreateConversationShareRoutes
import com.genflowly.activity.conversation.registerCreateConversationTitleRoutes
import com.genflowly.activity.conversation.registerDeleteConversationRoutes
import com.genflowly.activity.conversation.registerGetConversationRoutes
import com.genflowly.activity.conversation.registerGetConversationSharedUsersRoutes
import com.genflowly.activity.conversation.registerGetCustomerConversationsPaginatedRoutes
import com.genflowly.activity.conversation.registerUnarchiveConversationRoutes
import com.genflowly.activity.customer.registerCustomerProfileSettingsRoutes
import com.genflowly.activity.customer.registerGetProfileRoutes
import com.genflowly.activity.customer.registerOnboardCustomerRoutes
import com.genflowly.activity.customer.registerSearchRoutes
import com.genflowly.activity.customer.registerStoreApiKeyRoutes
import com.genflowly.activity.customer.registerStoreSupabaseConfigRoutes
import com.genflowly.activity.customer.registerStoreVectorDBConfigRoutes
import com.genflowly.activity.customer.registerToolCredentialsRoutes
import com.genflowly.activity.generation.registerGenerateTextRoutes
import com.genflowly.activity.generation.registerGenerateTextStreamRoutes
import com.genflowly.activity.generation.registerGetAIUsageActivityRoutes
import com.genflowly.activity.generation.registerGetTextGenerationModelsRoutes
import com.genflowly.activity.generation.registerSaveAIConfigPreferencesRoutes
import com.genflowly.activity.instruction.registerCreateInstructionRoutes
import com.genflowly.activity.instruction.registerCreateInstructionShareRoutes
import com.genflowly.activity.instruction.registerDeleteInstructionRoutes
import com.genflowly.activity.instruction.registerGetCustomerInstructionListRoutes
import com.genflowly.activity.instruction.registerGetInstructionSharedUsersRoutes
import com.genflowly.activity.instruction.registerGetInstructionVersionRoutes
import com.genflowly.activity.developer.registerDeveloperApiKeysRoutes
import com.genflowly.activity.admin.registerSystemVendorApiKeysRoutes
import com.genflowly.activity.attachment.registerAttachmentRoutes
import com.genflowly.activity.notes.registerNotesRoutes
import com.genflowly.activity.voice.registerGetVoiceModelsRoutes
import com.genflowly.activity.voice.registerVoiceSessionRoutes
import com.genflowly.service.DeveloperApiKeyService
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.openApi
import io.github.smiley4.ktorswaggerui.swaggerUI
import io.ktor.http.ContentType
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import com.genflowly.service.CustomerCredentialsService
import com.genflowly.service.GenerationOrchestrator
import com.genflowly.service.InstructionService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.ConversationService
import com.genflowly.service.AIModelsService
import com.genflowly.service.GraphService
import com.genflowly.config.AppConfig
import com.genflowly.service.AttachmentService
import com.genflowly.service.VoiceSessionService

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

    const val TOOL_CREDENTIALS = "$API_V1/tool-credentials"
    const val TOOL_CREDENTIAL = "$API_V1/tool-credentials/{toolType}"

    const val GET_CUSTOMER_AGENTS = "$API_V1/agents"
    const val UPDATE_AGENT = "$API_V1/agents/{graphId}"

    const val DEVELOPER_API_KEYS = "$API_V1/developer/api-keys"
    const val DEVELOPER_API_KEY = "$API_V1/developer/api-keys/{keyId}"

    const val ADMIN_SYSTEM_API_KEYS = "$API_V1/admin/system-api-keys"
    const val ADMIN_SYSTEM_API_KEY_CONFIG = "$API_V1/admin/system-api-keys/config"
    const val ADMIN_SYSTEM_API_KEY = "$API_V1/admin/system-api-keys/{aiVendor}"
    const val ADMIN_SYSTEM_API_KEY_MODELS = "$API_V1/admin/system-api-keys/{aiVendor}/models"
    const val ADMIN_MODEL_CATALOG_REFRESH = "$API_V1/admin/model-catalog/refresh"

    const val VOICE_SESSION = "$API_V1/voice/session"
    const val GET_VOICE_MODELS = "$API_V1/voice/models"

    const val CREATE_ATTACHMENT = "$API_V1/attachments"
    const val GET_ATTACHMENT_URL = "$API_V1/attachments/{attachmentId}/url"
}




fun Application.configureRouting(
    generationOrchestrator: GenerationOrchestrator,
    customerProfileService: CustomerProfileService,
    customerCredentialsService: CustomerCredentialsService,
    instructionService: InstructionService,
    conversationService: ConversationService,
    aiModelsService: AIModelsService,
    graphService: GraphService,
    attachmentService: AttachmentService,
    voiceSessionService: VoiceSessionService,
    notesService: com.genflowly.service.NotesService,
    developerApiKeyService: DeveloperApiKeyService,
    systemApiKeyService: com.genflowly.service.SystemApiKeyService,
    modelCatalogService: com.genflowly.service.ModelCatalogService,
    retrievalServerClient: com.genflowly.providers.RetrievalServerClient,
    appConfig: AppConfig,
) {
    routing {
        get(Routes.API_ROOT) {
            call.respondText("Hello World!")
        }

        // Generated OpenAPI specification + interactive Swagger UI
        route("/api.json") {
            openApi()
        }
        route("/swagger") {
            swaggerUI("/api.json")
        }

        // Customer-facing API docs (Scalar), reading the generated spec at /api.json
        val scalarDocsHtml = object {}.javaClass.getResource("/docs/index.html")!!.readText()
        get("/docs", { hidden = true }) {
            call.respondText(scalarDocsHtml, ContentType.Text.Html)
        }

        registerGenerateTextRoutes(generationOrchestrator, customerProfileService)
        registerGenerateTextStreamRoutes(generationOrchestrator, customerProfileService)
        registerStoreApiKeyRoutes(customerCredentialsService, customerProfileService)
        registerStoreVectorDBConfigRoutes(customerCredentialsService, customerProfileService)
        registerStoreSupabaseConfigRoutes(customerCredentialsService, customerProfileService)
        registerOnboardCustomerRoutes(customerProfileService)
        registerGetTextGenerationModelsRoutes(aiModelsService, customerProfileService)
        registerSaveAIConfigPreferencesRoutes(customerProfileService)
        registerGetConversationRoutes(customerProfileService, conversationService)
        registerCreateInstructionRoutes(instructionService, customerProfileService)
        registerCreateInstructionShareRoutes(instructionService, customerProfileService)
        registerCreateConversationShareRoutes(customerProfileService, conversationService)
        registerGetConversationSharedUsersRoutes(customerProfileService, conversationService)
        registerDeleteInstructionRoutes(instructionService, customerProfileService)
        registerGetCustomerInstructionListRoutes(instructionService, customerProfileService)
        registerGetInstructionVersionRoutes(instructionService, customerProfileService)
        registerGetInstructionSharedUsersRoutes(instructionService, customerProfileService)
        registerCreateConversationTitleRoutes(conversationService, customerProfileService)
        registerGetAIUsageActivityRoutes(conversationService, customerProfileService)
        registerGetCustomerConversationsPaginatedRoutes(customerProfileService, conversationService)
        registerDeleteConversationRoutes(customerProfileService, conversationService)
        registerUnarchiveConversationRoutes(customerProfileService, conversationService)
        registerGetCustomerAgentsRoutes(graphService, customerProfileService)
        registerUpdateAgentRoutes(graphService, customerProfileService)
        registerToolCredentialsRoutes(customerCredentialsService, customerProfileService)
        
        registerCustomerProfileSettingsRoutes(customerProfileService)
        registerSearchRoutes(customerProfileService)
        registerGetProfileRoutes(customerProfileService)
        registerAttachmentRoutes(attachmentService, customerProfileService)
        registerNotesRoutes(notesService, customerProfileService)
        registerDeveloperApiKeysRoutes(developerApiKeyService, customerProfileService)
        registerSystemVendorApiKeysRoutes(
            systemApiKeyService, customerProfileService, aiModelsService, appConfig, modelCatalogService
        )
        registerVoiceSessionRoutes(customerProfileService, voiceSessionService, retrievalServerClient)
        registerGetVoiceModelsRoutes(aiModelsService, customerProfileService)
    }
}
