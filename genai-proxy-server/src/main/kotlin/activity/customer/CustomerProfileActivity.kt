package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.api.AiDataConsentResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.SuccessResponse
import com.genflowly.models.api.UpdateUsernameRequest
import com.genflowly.models.api.UpdateDiscoverabilityRequest
import com.genflowly.service.CustomerProfileService
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

fun Route.registerCustomerProfileSettingsRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.UPDATE_USERNAME, {
            tags("Customer")
            summary = "Update username"
            description = "Sets the customer's unique username. Fails with 409 if already taken. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            request {
                body<UpdateUsernameRequest> {
                    description = "The new username"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Username updated"
                    body<SuccessResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "Customer profile not found"
                    body<String>()
                }
                code(HttpStatusCode.Conflict) {
                    description = "Username is already taken"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                }
            }
        }) {
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@post call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"
            
            val request = call.receive<UpdateUsernameRequest>()
            
            try {
                val profile = customerProfileService.getProfile(sub, client)
                if (profile == null) {
                    call.respond(HttpStatusCode.NotFound, "Profile not found")
                    return@post
                }
                
                val customerId = profile["customerId"]?.s() ?: return@post call.respond(HttpStatusCode.InternalServerError)
                val oldUsername = profile["username"]?.s()
                
                customerProfileService.updateUsername(sub, client, customerId, oldUsername, request.username)
                call.respond(HttpStatusCode.OK, mapOf("success" to true))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.Conflict, mapOf("error" to "Username is already taken"))
            } catch (e: Exception) {
                logger.error("Failed to update username", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }

        post(Routes.UPDATE_DISCOVERABILITY, {
            tags("Customer")
            summary = "Update discoverability"
            description = "Controls whether the customer can be found via user search. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            request {
                body<UpdateDiscoverabilityRequest> {
                    description = "Whether the profile is discoverable"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Discoverability updated"
                    body<SuccessResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                }
            }
        }) {
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@post call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"
            
            val request = call.receive<UpdateDiscoverabilityRequest>()
            
            try {
                customerProfileService.updateDiscoverability(sub, client, request.isDiscoverable)
                call.respond(HttpStatusCode.OK, mapOf("success" to true))
            } catch (e: Exception) {
                logger.error("Failed to update discoverability", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }

        post(Routes.COMPLETE_ONBOARDING, {
            tags("Customer")
            summary = "Mark first-time onboarding as completed"
            description = "Dismisses the first-time setup wizard for this customer, whether finished or skipped. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            response {
                code(HttpStatusCode.OK) {
                    description = "Onboarding marked as completed"
                    body<SuccessResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                }
            }
        }) {
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@post call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"

            try {
                customerProfileService.completeOnboarding(sub, client)
                call.respond(HttpStatusCode.OK, mapOf("success" to true))
            } catch (e: Exception) {
                logger.error("Failed to complete onboarding", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }

        post(Routes.AI_DATA_CONSENT, {
            tags("Customer")
            summary = "Agree to the AI data consent screen"
            description = "Records that the customer agreed to the current version of the screen that says " +
                    "what is sent to third-party services and who receives it. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            response {
                code(HttpStatusCode.OK) {
                    description = "Agreement recorded"
                    body<AiDataConsentResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                }
            }
        }) {
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@post call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"

            try {
                val acceptedAt = customerProfileService.acceptAiDataConsent(sub, client)
                call.respond(HttpStatusCode.OK, AiDataConsentResponse(aiDataConsentAt = acceptedAt))
            } catch (e: Exception) {
                logger.error("Failed to record AI data consent", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }
    }
}
