package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.api.OnboardCustomerResponse
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.service.CustomerProfileService
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.http.HttpHeaders
import models.OnboardCustomerRequest
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("OnboardCustomerRoute")

fun Route.registerOnboardCustomerRoutes(
    customerProfileService: CustomerProfileService,
    aiRequestManager: AIRequestManager
) {
    authenticate("auth0") {
        post(Routes.ONBOARD_CUSTOMER, {
            tags("Customer")
            summary = "Onboard the authenticated user"
            description = "Creates (or returns) the customer profile for the authenticated Auth0 " +
                    "identity. Must be called once before any other endpoint; other endpoints " +
                    "return 403 for identities without a profile. Returns the full bootstrap state: " +
                    "preferences, API-key statuses, instructions and configuration statuses. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            request {
                body<OnboardCustomerRequest> {
                    description = "Auth0 identity attributes (sub, client, email, name, picture)"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Customer profile and bootstrap state"
                    body<OnboardCustomerResponse>()
                }
            }
        }) {
            val request = call.receive<OnboardCustomerRequest>()
            logger.info(
                "Onboarding user: sub={}, email={}, name={}, picture={}",
                request.sub,
                request.email ?: "not provided",
                request.name ?: "not provided",
                request.picture ?: "not provided",
            )

            val authHeader = call.request.headers[HttpHeaders.Authorization]

            val customerProfile = customerProfileService.onboardCustomer(
                sub = request.sub,
                client = request.client,
                email = request.email,
                name = request.name,
                picture = request.picture,
                authHeader = authHeader
            )

            // Fetch additional details
            val aiConfigPreferences = customerProfileService.getAIConfigPreferences(customerProfile.customerId)
                ?: AIConfigPreferences()
            
            val aiVendorAPIKeyStatusList = customerProfileService.getAIVendorAPIKeyStatusList(customerProfile.customerId)
            
            val vectorDBConfigStatusList = customerProfileService.getCustomerVectorDBConfigStatusList(customerProfile.customerId)
            
            val supabaseConfigStatus = customerProfileService.getCustomerSupabaseConfigStatus(customerProfile.customerId)

            val customerInstructions = customerProfileService.getLatestCustomerInstructions(customerProfile.customerId)
            
            // Fire and forget backfill missing categories/icons using AI
            customerProfileService.backfillInstructionsAsync(customerProfile.customerId, customerInstructions, aiRequestManager)

            val response = OnboardCustomerResponse(
                customerId = customerProfile.customerId,
                aiConfigPreferences = aiConfigPreferences,
                aiVendorAPIKeyStatusList = aiVendorAPIKeyStatusList,
                customerName = customerProfile.name ?: "User",
                customerPicture = customerProfile.picture,
                customerInstructions = customerInstructions,
                vectorDBConfigStatusList = vectorDBConfigStatusList,
                supabaseConfigStatus = supabaseConfigStatus
            )

            call.respond(response)
        }
    }
}


