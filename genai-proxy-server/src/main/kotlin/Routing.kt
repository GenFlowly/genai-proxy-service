package com.genflowly

import activity.registerOnboardCustomerRoutes
import activity.registerStoreApiKeyRoutes
import com.genflowly.activity.registerCreateInstructionRoutes
import com.genflowly.activity.registerGenerateTextRoutes
import com.genflowly.activity.registerGetTextGenerationModelsRoutes
import com.genflowly.activity.registerSaveAIConfigPreferencesRoutes
import com.genflowly.service.AIRequestService
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import service.AIRequestManager
import service.CustomerProfileService
import com.genflowly.activity.registerGetConversationRoutes
import com.genflowly.service.ConversationService

object Routes {
    private const val API_V1 = "/api/v1"
    const val API_ROOT = "/"

    const val GENERATE_TEXT = "$API_V1/generate-text"
    const val STORE_API_KEY = "$API_V1/store-api-key"
    const val ONBOARD_CUSTOMER = "$API_V1/onboard"
    const val GET_TEXT_GENERATION_MODELS = "$API_V1/models"
    const val SAVE_AI_CONFIG_PREFERENCES = "$API_V1/save-ai-config"
    const val GET_CONVERSATION = "$API_V1/chat"
    const val CREATE_INSTRUCTION = "$API_V1/instruction"
}




fun Application.configureRouting(
    aiRequestService: AIRequestService,
    aiRequestManager: AIRequestManager,
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService
) {
    routing {
        get(Routes.API_ROOT) {
            call.respondText("Hello World!")
        }

        registerGenerateTextRoutes(aiRequestManager, customerProfileService)
        registerStoreApiKeyRoutes(customerProfileService)
        registerOnboardCustomerRoutes(customerProfileService)
        registerGetTextGenerationModelsRoutes(aiRequestService, customerProfileService)
        registerSaveAIConfigPreferencesRoutes(customerProfileService)
        registerGetConversationRoutes(customerProfileService, conversationService)
        registerCreateInstructionRoutes(aiRequestManager,
            customerProfileService)
    }
}
