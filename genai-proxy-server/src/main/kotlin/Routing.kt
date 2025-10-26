package com.genflowly

import activity.registerOnboardCustomerRoutes
import activity.registerStoreApiKeyRoutes
import com.genflowly.Routes.API_ROOT
import com.genflowly.activity.registerGenerateTextRoutes
import com.genflowly.service.AIRequestService
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import service.CustomerProfileService


object Routes {
    private const val API_V1 = "/api/v1"
    const val API_ROOT = "/"

    const val GENERATE_TEXT = "$API_V1/generate-text"
    const val STORE_API_KEY = "$API_V1/store-api-key"
    const val ONBOARD_CUSTOMER = "$API_V1/onboard"
}

fun Application.configureRouting(
    aiRequestService: AIRequestService,
    customerProfileService: CustomerProfileService
) {
    routing {
        get(API_ROOT) {
            println("Receiving GET request")
            call.respondText("Hello World!")
        }

        registerGenerateTextRoutes(aiRequestService, customerProfileService)
        registerStoreApiKeyRoutes(customerProfileService)
        registerOnboardCustomerRoutes(customerProfileService)
    }
}
