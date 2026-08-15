package com.genflowly.activity.voice

import com.genflowly.Routes
import com.genflowly.models.api.GetTextGenerationModelsRequest
import com.genflowly.models.api.GetTextGenerationModelsResponse
import com.genflowly.service.AIModelsService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route

fun Route.registerGetVoiceModelsRoutes(
    aiModelsService: AIModelsService,
    customerProfileService: CustomerProfileService
) {

    authenticate("auth0", "apiKey") {
        post(Routes.GET_VOICE_MODELS, {
            tags("Voice")
            summary = "List available realtime voice models"
            description = "Returns the realtime voice models available to the customer for the " +
                    "requested AI vendors, based on the API keys the customer has stored. " +
                    "Only models usable for live speech-to-speech sessions are included " +
                    "(OpenAI Realtime API models, Gemini Live API models). Anthropic has no " +
                    "realtime voice API, so CLAUDE always returns an empty list. Use these " +
                    "model ids in the session.init message of the voice session WebSocket " +
                    "(${Routes.VOICE_SESSION})."
            request {
                body<GetTextGenerationModelsRequest> {
                    description = "AI vendors to list voice models for"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Voice models grouped by AI vendor"
                    body<GetTextGenerationModelsResponse>()
                }
            }
        }) {
            val request = call.receive<GetTextGenerationModelsRequest>()

            val customerId = call.requireAuthenticatedCustomerId(
                customerProfileService
            )

            val aiVendorModelList = aiModelsService.getModelsForVendors(
                request.aiVendor,
                customerId,
                capability = "voice"
            )

            call.respond(GetTextGenerationModelsResponse(aiVendorModelList = aiVendorModelList))
        }
    }
}
