package com.genflowly.activity.generation

import com.genflowly.Routes
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GenerationOrchestrator
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CancelGenerationActivity")

/**
 * True cancel for an in-flight streamed generation. Since generation is
 * decoupled from the HTTP stream (it survives client disconnects so mobile
 * backgrounding doesn't lose responses), closing the stream no longer stops
 * it — this endpoint does. The partial text streamed so far is persisted.
 */
fun Route.registerCancelGenerationRoute(
    generationOrchestrator: GenerationOrchestrator,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.CANCEL_GENERATION, {
            tags("Generation")
            summary = "Cancel an in-flight streamed generation"
            description = "Stops the model generation running for the given id — either the " +
                    "X-Response-Message-Id from the stream's response headers, or the " +
                    "client-generated generationId sent with the generate request (usable " +
                    "immediately, before headers arrive). The partial text streamed so far " +
                    "is kept as the response message. Returns cancelled=false when nothing " +
                    "is running under that id; the id is then remembered briefly so a " +
                    "generation still in pre-launch setup self-cancels once it registers."
            request {
                queryParameter<String>("responseMessageId") {
                    description = "Response message id or client generationId of the in-flight generation"
                    required = true
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val responseMessageId = call.request.queryParameters["responseMessageId"]
            if (responseMessageId.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "responseMessageId is required"))
                return@post
            }
            val cancelled = generationOrchestrator.cancelGeneration(customerId, responseMessageId)
            logger.info("Cancel request for generation {} by {} -> {}", responseMessageId, customerId, cancelled)
            call.respond(HttpStatusCode.OK, mapOf("cancelled" to cancelled))
        }
    }
}
