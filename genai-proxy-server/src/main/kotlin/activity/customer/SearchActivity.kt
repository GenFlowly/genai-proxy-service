package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.SearchCustomerResponse
import com.genflowly.repository.CustomerProfileRepository
import io.github.smiley4.ktoropenapi.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

fun Route.registerSearchRoutes(
    customerProfileRepository: CustomerProfileRepository
) {
    authenticate("auth0") {
        get(Routes.SEARCH_USERS, {
            tags("Customer")
            summary = "Search users by username"
            description = "Prefix-searches discoverable users by username. The caller is excluded " +
                    "from the results. Web-app only: requires an Auth0 JWT; not accessible with a " +
                    "developer API key."
            request {
                queryParameter<String>("username") {
                    description = "Username prefix to search for"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Matching users"
                    body<List<SearchCustomerResponse>>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing username parameter"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                }
            }
        }) {
            val username = call.request.queryParameters["username"]
            if (username.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing username parameter"))
                return@get
            }
            
            val principal = call.principal<JWTPrincipal>()
            val sub = principal?.payload?.subject ?: return@get call.respond(HttpStatusCode.Unauthorized)
            val client = "REACT_APP"
            
            try {
                val currentUserProfile = customerProfileRepository.getCustomerProfile(sub, client)
                val currentCustomerId = currentUserProfile?.get("customerId")?.s()
                
                val response = customerProfileRepository.searchByUsername(username)
                val filteredResponse = response.filter { it.customerId != currentCustomerId }
                
                call.respond(HttpStatusCode.OK, filteredResponse)
            } catch (e: Exception) {
                logger.error("Failed to search by username", e)
                call.respond(HttpStatusCode.InternalServerError)
            }
        }
    }
}
