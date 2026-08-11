package com.genflowly.activity.customer

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
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.AIModelsService
import models.AIVendorAPIKeyStatus
import models.APIKeyStatus

private val logger = LoggerFactory.getLogger("StoreCustomerVendorApiKeyRoute")

fun Route.registerStoreApiKeyRoutes(
    customerProfileService: CustomerProfileService,
    aiModelsService: AIModelsService
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

            // Validate API Key by fetching models
            val models = aiModelsService.getModelsWithApiKey(aiVendor, request.apiKey)

            if (models.modelsList.isNotEmpty()) {
                // Key is valid -> Store it
                val stored = customerProfileService.storeApiKey(
                    customerId = customerId,
                    aiVendor = request.aiVendor,
                    apiKey = request.apiKey
                )
                
                logger.info("API Key validated and stored for vendor {}: {}", aiVendor, stored)

                val response = StoreCustomerVendorApiKeyResponse(
                    apiKeyStatus = AIVendorAPIKeyStatus(
                        aiVendor = aiVendor,
                        isAPIKeyValid = true,
                        status = APIKeyStatus.VALID,
                        updateSuccessful = true
                    )
                )
                call.respond(response)
            } else {
                // Key is invalid -> Do NOT store
                logger.warn("Invalid API Key provided for vendor {}. Not saving.", aiVendor)

                val response = StoreCustomerVendorApiKeyResponse(
                    apiKeyStatus = AIVendorAPIKeyStatus(
                        aiVendor = aiVendor,
                        isAPIKeyValid = false,
                        status = APIKeyStatus.INVALID,
                        updateSuccessful = false
                    )
                )
                call.respond(response)
            }
        }
    }
}
