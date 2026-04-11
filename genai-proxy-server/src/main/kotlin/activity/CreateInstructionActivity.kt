package com.genflowly.activity

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

                val instructionName = if (!request.instructionName.isNullOrBlank()) {
                    request.instructionName
                } else {
                    aiRequestManager.generateInstructionPersona(request.instruction, customerId)
                }
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