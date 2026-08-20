package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.api.CustomerProfileResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.repository.CustomerProfileRepository
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

fun Route.registerGetProfileRoutes(
    customerProfileRepository: CustomerProfileRepository
) {
    authenticate("auth0") {
        get(Routes.GET_PROFILE, {
            tags("Customer")
            summary = "Get the authenticated user's profile"
            description = "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            response {
                code(HttpStatusCode.OK) {
                    description = "The customer profile"
                    body<CustomerProfileResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "Customer profile not found"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                }
            }
        }) {
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@get call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"
            
            try {
                val profile = customerProfileRepository.getCustomerProfile(sub, client)
                if (profile == null) {
                    call.respond(HttpStatusCode.NotFound, mapOf("error" to "Profile not found"))
                    return@get
                }
                
                val response = CustomerProfileResponse(
                    customerId = profile["customerId"]?.s() ?: "",
                    name = profile["name"]?.s(),
                    email = profile["email"]?.s(),
                    username = profile["username"]?.s(),
                    picture = profile["picture"]?.s(),
                    isDiscoverable = profile["isDiscoverable"]?.bool() ?: false
                )
                call.respond(HttpStatusCode.OK, response)
            } catch (e: Exception) {
                logger.error("Failed to get profile", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }
    }
}
