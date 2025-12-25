package activity

import com.genflowly.Routes
import com.genflowly.models.OnboardCustomerResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import java.util.UUID
import models.OnboardCustomerRequest
import org.slf4j.LoggerFactory
import service.CustomerProfileService

private val logger = LoggerFactory.getLogger("OnboardCustomerRoute")

fun Route.registerOnboardCustomerRoutes(
    customerProfileService: CustomerProfileService
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
                ?: com.genflowly.models.AIConfigPreferences()
            
            val aiVendorAPIKeyStatusList = customerProfileService.getAIVendorAPIKeyStatusList(customerProfile.customerId)

            val response = OnboardCustomerResponse(
                customerId = customerProfile.customerId,
                aiConfigPreferences = aiConfigPreferences,
                aiVendorAPIKeyStatusList = aiVendorAPIKeyStatusList,
                customerName = customerProfile.name ?: "User",
                customerPicture = customerProfile.picture
            )

            call.respond(response)
        }
    }
}


