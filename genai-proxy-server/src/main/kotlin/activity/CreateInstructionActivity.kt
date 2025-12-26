package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.CreateInstructionRequest
import com.genflowly.providers.DynamoDBProvider
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory
import service.AIRequestManager
import service.CustomerProfileService

private val logger = LoggerFactory.getLogger("CreateInstructionRoute")

fun Route.registerCreateInstructionRoutes(
    aiRequestManager: AIRequestManager,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.CREATE_INSTRUCTION) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val request = call.receive<CreateInstructionRequest>()

                val instructionName = aiRequestManager
                    .generateText(
                        AIVendor.OPENAI,
                        "gpt-3.5-turbo",
                        request.instruction,
                        "Create a persona for this system instructions.\n" +
                                "\n" +
                                "The role should be generic enough to be understood what are it's key technical skills but also specific enough to not make it a broad term.\n" +
                                "\n" +
                                "\n" +
                                "Return only the name of Role, nothing else",
                        customerId
                    )
                val response = customerProfileService.createInstruction(
                    customerId, instructionName, request.instruction,
                    request.existingInstructionId)

                call.respond(response)

            } catch (e: Exception) {
                logger.error(
                    "Unexpected error in Create Instruction controller: {}",
                    e.message,
                    e
                )
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Internal server error: ${e.message}")
                )
            }
        }
    }
}