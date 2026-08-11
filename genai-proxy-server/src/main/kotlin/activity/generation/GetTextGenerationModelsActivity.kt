package com.genflowly.activity.generation

import com.genflowly.Routes
import com.genflowly.aicallerlib.clients.AIClient
import com.genflowly.aicallerlib.models.*
import com.genflowly.aicallerlib.models.claude.*
import com.genflowly.aicallerlib.models.gemini.*
import com.genflowly.aicallerlib.models.openai.*
import com.genflowly.models.api.AIVendorModelList
import com.genflowly.models.api.GetTextGenerationModelsRequest
import com.genflowly.models.api.GetTextGenerationModelsResponse
import com.genflowly.service.AIRequestService
import com.genflowly.service.AIModelsService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("GetTextGenerationModelsRoute")

fun Route.registerGetTextGenerationModelsRoutes(
    aiModelsService: AIModelsService,
    customerProfileService: CustomerProfileService
) {

    authenticate("auth0") {
        post(Routes.GET_TEXT_GENERATION_MODELS, {
            tags("Generation")
            summary = "List available text-generation models"
            description = "Returns the models available to the customer for the requested AI " +
                    "vendors, based on the API keys the customer has stored."
            request {
                body<GetTextGenerationModelsRequest> {
                    description = "AI vendors to list models for"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Models grouped by AI vendor"
                    body<GetTextGenerationModelsResponse>()
                }
            }
        }) {
            val request = call.receive<GetTextGenerationModelsRequest>()
            
            // Extract customerId from JWT token
            val customerId = call.requireAuthenticatedCustomerId(
                customerProfileService
            )

            val aiVendorModelList = aiModelsService.getModelsForVendors(
                request.aiVendor,
                customerId
            )

            val response = GetTextGenerationModelsResponse(
                aiVendorModelList = aiVendorModelList
            )

            call.respond(response)
        }
    }
}
