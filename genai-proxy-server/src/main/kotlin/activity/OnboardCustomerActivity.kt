package activity

import com.genflowly.Routes
import com.genflowly.models.OnboardCustomerResponse
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
    post(Routes.ONBOARD_CUSTOMER) {
        val request = call.receive<OnboardCustomerRequest>()
        logger.info("Onboarding user: sub={}, email={}, name={}",
            request.sub,
            request.email ?: "not provided",
            request.name ?: "not provided"
        )

        val customerId: String = generateCustomerId()
        logger.info("Generated customer ID: {}", customerId)

        customerProfileService.onboardCustomer(
            sub = request.sub,
            client = request.client,
            customerId = customerId,
            email = request.email,
            name = request.name
        )

        val response = OnboardCustomerResponse(
            customerId = customerId
        )

        call.respond(response)
    }
}

fun generateCustomerId(): String {
    val uuid = UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "CUSTOMER-$uuid"
}
