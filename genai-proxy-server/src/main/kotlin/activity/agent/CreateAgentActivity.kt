package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.models.api.AgentResponse
import com.genflowly.models.api.CreateAgentRequest
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CreateAgentActivity")

fun Route.registerCreateAgentRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0", "apiKey") {
        post(Routes.CREATE_AGENT, {
            tags("Agents")
            summary = "Create a generation agent"
            description = "Creates a 1-node GENERATION agent owned by the caller: a graph whose single " +
                    "node references the instruction holding the system-prompt template. " +
                    "instructionVersion omitted/null follows the instruction's latest version."
            request {
                body<CreateAgentRequest> {
                    description = "Agent definition"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.Created) {
                    description = "The created agent (hydrated graph + node)"
                    body<AgentResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Invalid request (blank name, unknown instruction)"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val req = call.receive<CreateAgentRequest>()
                val response = try {
                    graphService.createGenerationAgent(customerId, req)
                } catch (e: IllegalArgumentException) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Invalid agent: ${e.message}")
                    )
                }
                call.respond(HttpStatusCode.Created, response)
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: Exception) {
                logger.error("Unexpected error creating agent: {}", e.message, e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }
    }
}
