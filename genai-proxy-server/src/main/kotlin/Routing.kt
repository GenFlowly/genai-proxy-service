package com.genflowly

import activity.registerSaveApiKeyRoutes
import com.genflowly.activity.registerGenerateTextRoutes
import com.genflowly.service.AIRequestService
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*


object Routes {
    private const val API_V1 = "/api/v1"

    const val GENERATE_TEXT = "$API_V1/generate-text"
    const val SAVE_API_KEY = "$API_V1/save-api-key"
}

fun Application.configureRouting(aiService: AIRequestService) {
    routing {
        get("/") {
            println("Receiving GET request")
            call.respondText("Hello World!")
        }

        registerGenerateTextRoutes(aiService)
        registerSaveApiKeyRoutes()
    }
}
