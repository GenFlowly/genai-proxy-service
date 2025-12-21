package activity

import com.genflowly.Routes
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.server.auth.authenticate
import io.ktor.server.routing.post
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import models.StoreCustomerVendorApiKeyResponse
import models.StoreCustomerVendorApiKeyRequest
import org.slf4j.LoggerFactory
import service.CustomerProfileService

private val logger = LoggerFactory.getLogger("StoreCustomerVendorApiKeyRoute")

fun Route.registerStoreApiKeyRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.STORE_API_KEY) {
            val request = call.receive<StoreCustomerVendorApiKeyRequest>()
            
            // Extract customerId from JWT token
            val customerId = call.requireAuthenticatedCustomerId(
                customerProfileService
            )
            
            logger.info("Received SaveApiKeyRequest from customerId {}: {}", customerId, request)

            val aiVendor = com.genflowly.aicallerlib.models.AIVendor.valueOf(request.aiVendor)

            val isValid = customerProfileService.storeApiKey(
                customerId = customerId,
                aiVendor = request.aiVendor,
                apiKey = request.apiKey
            )

            val response = StoreCustomerVendorApiKeyResponse(
                apiKeyResponse = models.AIVendorAPIKeyResponse(
                    aiVendor = aiVendor,
                    isAPIKeyValid = isValid
                )
            )
            call.respond(response)
        }
    }
}
