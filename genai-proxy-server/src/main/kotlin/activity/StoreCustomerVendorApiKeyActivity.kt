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
                customerProfileService,
                request.client
            )
            
            logger.info("Received SaveApiKeyRequest from customerId {}: {}", customerId, request)

            customerProfileService.storeApiKey(
                customerId = customerId,
                aiVendor = request.aiVendor, //TODO add validation with enum
                apiKey = request.apiKey
            )

            val response = StoreCustomerVendorApiKeyResponse(
                status = "API key saved for customer ${customerId}" +
                        "vendor ${request.aiVendor}"
            )
            call.respond(response)
        }
    }
}
