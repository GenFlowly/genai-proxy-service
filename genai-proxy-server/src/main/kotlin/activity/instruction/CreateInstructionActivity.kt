package com.genflowly.activity.instruction

import com.genflowly.Routes
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.CreateInstructionRequest
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory
import service.AIRequestManager
import models.Message
import models.AIConfig

import com.genflowly.service.CustomerProfileService

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

                // Always generate the persona metadata (icon, color, tags) via AI
                val generatedPersona = aiRequestManager.generateInstructionPersona(request.instruction, customerId)

                // Use user-provided name if available, otherwise use AI-generated name
                val instructionName = if (!request.instructionName.isNullOrBlank()) {
                    request.instructionName
                } else {
                    generatedPersona.name
                }

                val response = customerProfileService.createInstruction(
                    customerId = customerId, 
                    instructionName = instructionName, 
                    instruction = request.instruction,
                    existingInstructionId = request.existingInstructionId,
                    icon = generatedPersona.icon,
                    color = generatedPersona.color,
                    tags = generatedPersona.tags,
                    category = generatedPersona.category
                )

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