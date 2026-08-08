package activity

import com.genflowly.Routes
import com.genflowly.models.api.OnboardCustomerResponse
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.service.CustomerProfileService
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import models.OnboardCustomerRequest
import org.slf4j.LoggerFactory
import service.AIRequestManager

private val logger = LoggerFactory.getLogger("OnboardCustomerRoute")

fun Route.registerOnboardCustomerRoutes(
    customerProfileService: CustomerProfileService,
    aiRequestManager: AIRequestManager
) {
    authenticate("auth0") {
        post(Routes.ONBOARD_CUSTOMER) {
            val request = call.receive<OnboardCustomerRequest>()
            logger.info(
                "Onboarding user: sub={}, email={}, name={}, picture={}",
                request.sub,
                request.email ?: "not provided",
                request.name ?: "not provided",
                request.picture ?: "not provided",
            )

            val customerProfile = customerProfileService.onboardCustomer(
                sub = request.sub,
                client = request.client,
                email = request.email,
                name = request.name,
                picture = request.picture
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


