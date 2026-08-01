package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.models.api.StoreToolCredentialsRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("ToolCredentialsRoute")

fun Route.registerToolCredentialsRoutes(customerProfileService: CustomerProfileService) {
    authenticate("auth0") {

        post(Routes.TOOL_CREDENTIALS) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val request = call.receive<StoreToolCredentialsRequest>()
            logger.info("Storing tool credentials for customerId={} toolType={}", customerId, request.toolType)
            val response = customerProfileService.storeToolCredentials(
                customerId = customerId,
                toolType = request.toolType,
                authType = request.authType,
                credentials = request.credentials,
            )
            call.respond(response)
        }

        get(Routes.TOOL_CREDENTIALS) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val response = customerProfileService.listToolCredentialStatuses(customerId)
            call.respond(response)
        }

        delete(Routes.TOOL_CREDENTIAL) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val toolType = call.parameters["toolType"]
                ?: return@delete call.respond(HttpStatusCode.BadRequest, "Missing toolType")
            customerProfileService.removeToolCredentials(customerId, toolType)
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
