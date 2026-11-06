package com.genflowly.activity.account

import com.genflowly.Routes
import com.genflowly.models.api.DeleteAccountRequest
import com.genflowly.models.api.DeleteAccountResponse
import com.genflowly.models.api.DeleteCredentialsResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.service.AccountDeletionRefusedException
import com.genflowly.service.AccountDeletionService
import com.genflowly.service.CustomerCredentialsService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("AccountActivity")

/** The text the client must send to confirm an account deletion. */
const val DELETE_ACCOUNT_CONFIRMATION = "DELETE"

/**
 * Account-level deletes from Settings > Profile. Both require an Auth0 JWT:
 * a developer API key can't delete the account or its keys.
 */
fun Route.registerAccountRoutes(
    accountDeletionService: AccountDeletionService,
    customerCredentialsService: CustomerCredentialsService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        delete(Routes.DELETE_ACCOUNT, {
            tags("Account")
            summary = "Delete the account"
            description = "Permanently deletes the account and everything it owns: conversations (shared ones " +
                    "and their public links included), notes, learned facts, instructions, agents, files, keys, " +
                    "and the vectors stored in the customer's vector DB. The login stops working at once; the " +
                    "rest is deleted in the background. Web-app only: requires an Auth0 JWT."
            request {
                body<DeleteAccountRequest> {
                    description = "confirmation must be \"$DELETE_ACCOUNT_CONFIRMATION\""
                    required = true
                }
            }
            response {
                code(HttpStatusCode.Accepted) {
                    description = "Deletion started"
                    body<DeleteAccountResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing or wrong confirmation"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.Forbidden) {
                    description = "This account can't be deleted here"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            val request = runCatching { call.receive<DeleteAccountRequest>() }.getOrNull()
            if (request?.confirmation != DELETE_ACCOUNT_CONFIRMATION) {
                return@delete call.respond(
                    HttpStatusCode.BadRequest,
                    mapOf("error" to "Confirm by sending confirmation \"$DELETE_ACCOUNT_CONFIRMATION\"")
                )
            }
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                accountDeletionService.requestDeletion(customerId)
                call.respond(HttpStatusCode.Accepted, DeleteAccountResponse(status = "deletion_started"))
            } catch (e: AccountDeletionRefusedException) {
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to (e.message ?: "Account can't be deleted here")))
            } catch (e: Exception) {
                logger.error("Error deleting account", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to delete the account"))
            }
        }

        delete(Routes.DELETE_CREDENTIALS, {
            tags("Account")
            summary = "Delete every stored key"
            description = "Removes every key and credential the customer stored: AI and embedding keys, the " +
                    "vector DB connection, and tool and connector credentials. Web-app only: requires an Auth0 JWT."
            response {
                code(HttpStatusCode.OK) {
                    description = "Credentials removed"
                    body<DeleteCredentialsResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val removed = customerCredentialsService.deleteAllCredentials(customerId)
                call.respond(HttpStatusCode.OK, DeleteCredentialsResponse(deleted = removed))
            } catch (e: Exception) {
                logger.error("Error deleting credentials", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Failed to delete keys"))
            }
        }
    }
}
