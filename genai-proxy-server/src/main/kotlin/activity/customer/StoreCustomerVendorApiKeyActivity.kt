package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import com.genflowly.models.StoreCustomerVendorApiKeyResponse
import com.genflowly.models.StoreCustomerVendorApiKeyRequest
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerCredentialsService
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("StoreCustomerVendorApiKeyRoute")

fun Route.registerStoreApiKeyRoutes(
    customerCredentialsService: CustomerCredentialsService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.STORE_API_KEY, {
            tags("Customer")
            summary = "Store an AI vendor API key"
            description = "Validates the API key against the vendor (by listing models) and stores " +
                    "it encrypted if valid. Invalid keys are not stored; the response reports the " +
                    "validation status either way."
            request {
                body<StoreCustomerVendorApiKeyRequest> {
                    description = "AI vendor name and the API key to store"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Validation and storage status of the key"
                    body<StoreCustomerVendorApiKeyResponse>()
                }
            }
        }) {
            val request = call.receive<StoreCustomerVendorApiKeyRequest>()
            
            // Extract customerId from JWT token
            val customerId = call.requireAuthenticatedCustomerId(
                customerProfileService
            )
            
            logger.info("Received SaveApiKeyRequest from customerId {}: {}", customerId, request)

            val aiVendor = com.genflowly.models.AIVendor.valueOf(request.aiVendor)

            // Validate against the vendor before storing; invalid keys are rejected
            val apiKeyStatus = customerCredentialsService.validateAndStoreVendorKey(
                customerId = customerId,
                vendor = aiVendor,
                apiKey = request.apiKey
            )

            call.respond(StoreCustomerVendorApiKeyResponse(apiKeyStatus = apiKeyStatus))
        }

        post(Routes.STORE_VENDOR_CONFIG, {
            tags("Customer")
            summary = "Store model + failover priority for an AI vendor"
            description = "Stores which model internal generations (conversation/note titles, " +
                    "instruction personas, memory extraction) should use for this vendor, and its " +
                    "failover priority (1 = primary). Requires a stored API key for the vendor."
            request {
                body<com.genflowly.models.StoreCustomerVendorConfigRequest> {
                    description = "AI vendor name, model id and priority (1 = primary)"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) { description = "Config stored" }
                code(HttpStatusCode.Conflict) { description = "No API key stored for the vendor" }
            }
        }) {
            val request = call.receive<com.genflowly.models.StoreCustomerVendorConfigRequest>()
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

            val aiVendor = try {
                com.genflowly.models.AIVendor.valueOf(request.aiVendor)
            } catch (e: IllegalArgumentException) {
                return@post call.respond(
                    HttpStatusCode.BadRequest,
                    mapOf("error" to "Unknown AI vendor: ${request.aiVendor}")
                )
            }
            if (request.model.isBlank()) {
                return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Model must not be blank"))
            }
            if (request.priority < 1) {
                return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Priority must be >= 1"))
            }

            logger.info(
                "Customer {} setting vendor config for {}: model={} priority={}",
                customerId, aiVendor, request.model, request.priority
            )
            try {
                customerCredentialsService.updateVendorConfig(customerId, aiVendor, request.model, request.priority)
            } catch (e: software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException) {
                return@post call.respond(
                    HttpStatusCode.Conflict,
                    mapOf("error" to "No API key stored for vendor ${aiVendor.name}")
                )
            }
            call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
        }
    }
}
