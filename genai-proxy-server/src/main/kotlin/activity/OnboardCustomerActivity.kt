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
            val principal = call.principal<JWTPrincipal>()

            if (principal == null) {
                logger.error("❌ Principal is NULL - Authentication failed at route level")
                return@post call.respond(
                    HttpStatusCode.Unauthorized,
                    mapOf("error" to "Principal is null")
                )
            }


            logger.info("✅ Principal retrieved: ${principal.payload.subject}")
            logger.info("📋 All claims in token: ${principal.payload.claims.keys}")

            val sub = principal.payload.getClaim("sub")?.asString()
            logger.info("📌 Sub from token: $sub")

            if (sub == null) {
                logger.error("❌ Missing 'sub' in token claims")
                return@post call.respond(
                    HttpStatusCode.Unauthorized,
                    mapOf("error" to "Missing 'sub' in token")
                )
            }

            val request = call.receive<OnboardCustomerRequest>()

            if (request.sub != sub) {
                logger.warn("Sub mismatch! Token sub: $sub, Request sub: ${request.sub}")
                return@post call.respond(
                    io.ktor.http.HttpStatusCode.Forbidden,
                    mapOf("error" to "Token subject does not match request")
                )
            }


            logger.info(
                "Onboarding user: sub={}, email={}, name={}",
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
}

fun generateCustomerId(): String {
    val uuid =
        UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "CUSTOMER-$uuid"
}
