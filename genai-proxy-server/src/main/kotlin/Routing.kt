package com.genflowly

import activity.registerOnboardCustomerRoutes
import com.genflowly.activity.registerStoreApiKeyRoutes
import com.genflowly.activity.registerCreateInstructionRoutes
import com.genflowly.activity.registerGenerateTextRoutes
import com.genflowly.activity.registerGenerateTextStreamRoutes
import com.genflowly.activity.registerGetTextGenerationModelsRoutes
import com.genflowly.activity.registerSaveAIConfigPreferencesRoutes
import com.genflowly.service.AIRequestService
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import service.AIRequestManager
import com.genflowly.service.CustomerProfileService
import com.genflowly.activity.registerGetConversationRoutes
import com.genflowly.activity.registerGetCustomerInstructionListRoutes
import com.genflowly.activity.registerGetInstructionVersionRoutes
import com.genflowly.service.ConversationService
import com.genflowly.service.AIModelsService

object Routes {
    private const val API_V1 = "/api/v1"
    const val API_ROOT = "/"

    const val GENERATE_TEXT = "$API_V1/generate-text"
    const val GENERATE_TEXT_STREAM = "$API_V1/generate-text-stream"
    const val STORE_API_KEY = "$API_V1/store-api-key"
    const val ONBOARD_CUSTOMER = "$API_V1/onboard"
    const val GET_TEXT_GENERATION_MODELS = "$API_V1/models"
    const val SAVE_AI_CONFIG_PREFERENCES = "$API_V1/save-ai-config"
    const val GET_CONVERSATION = "$API_V1/chat"
    const val CREATE_INSTRUCTION = "$API_V1/instruction"
    const val GET_CUSTOMER_INSTRUCTIONS = "$API_V1/instructions"
    const val GET_CUSTOMER_INSTRUCTION_VERSION = "$API_V1/instruction"
}




fun Application.configureRouting(
    aiRequestService: AIRequestService,
    aiRequestManager: AIRequestManager,
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService,
    aiModelsService: AIModelsService
) {
    routing {
        get(Routes.API_ROOT) {
            call.respondText("Hello World!")
        }

        registerGenerateTextRoutes(aiRequestManager, customerProfileService)
        registerGenerateTextStreamRoutes(aiRequestManager, customerProfileService)
        registerStoreApiKeyRoutes(customerProfileService, aiModelsService)
        registerOnboardCustomerRoutes(customerProfileService)
        registerGetTextGenerationModelsRoutes(aiModelsService, customerProfileService)
        registerSaveAIConfigPreferencesRoutes(customerProfileService)
        registerGetConversationRoutes(customerProfileService, conversationService)
        registerCreateInstructionRoutes(aiRequestManager,
            customerProfileService)
        registerGetCustomerInstructionListRoutes(customerProfileService)
        registerGetInstructionVersionRoutes(customerProfileService)
    }
}
