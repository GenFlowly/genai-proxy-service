package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.api.GetToolCredentialStatusListResponse
import com.genflowly.models.api.StoreToolCredentialsRequest
import com.genflowly.models.api.StoreToolCredentialsResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("ToolCredentialsRoute")

fun Route.registerToolCredentialsRoutes(customerProfileService: CustomerProfileService) {
    authenticate("auth0") {

        post(Routes.TOOL_CREDENTIALS, {
            tags("Tool Credentials")
            summary = "Store credentials for an external tool"
            request {
                body<StoreToolCredentialsRequest> {
                    description = "Tool type, auth type and the credential values"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Storage status of the credentials"
                    body<StoreToolCredentialsResponse>()
                }
            }
        }) {
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

        get(Routes.TOOL_CREDENTIALS, {
            tags("Tool Credentials")
            summary = "List tool credential statuses"
            description = "Returns which external tools have credentials configured. Credential " +
                    "values are never returned."
            response {
                code(HttpStatusCode.OK) {
                    description = "Status per tool type"
                    body<GetToolCredentialStatusListResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val response = customerProfileService.listToolCredentialStatuses(customerId)
            call.respond(response)
        }

        delete(Routes.TOOL_CREDENTIAL, {
            tags("Tool Credentials")
            summary = "Delete credentials for a tool"
            request {
                pathParameter<String>("toolType") {
                    description = "Tool type whose credentials are removed"
                }
            }
            response {
                code(HttpStatusCode.NoContent) {
                    description = "Credentials removed"
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing toolType"
                    body<String>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val toolType = call.parameters["toolType"]
                ?: return@delete call.respond(HttpStatusCode.BadRequest, "Missing toolType")
            customerProfileService.removeToolCredentials(customerId, toolType)
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
