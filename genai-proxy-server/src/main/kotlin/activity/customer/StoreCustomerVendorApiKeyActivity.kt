package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import models.StoreCustomerVendorApiKeyResponse
import models.StoreCustomerVendorApiKeyRequest
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

            val aiVendor = com.genflowly.aicallerlib.models.AIVendor.valueOf(request.aiVendor)

            // Validate against the vendor before storing; invalid keys are rejected
            val apiKeyStatus = customerCredentialsService.validateAndStoreVendorKey(
                customerId = customerId,
                vendor = aiVendor,
                apiKey = request.apiKey
            )

            call.respond(StoreCustomerVendorApiKeyResponse(apiKeyStatus = apiKeyStatus))
        }
    }
}
