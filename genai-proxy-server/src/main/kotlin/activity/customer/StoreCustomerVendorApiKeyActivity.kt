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
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.AIModelsService
import models.AIVendorAPIKeyStatus
import models.APIKeyStatus

private val logger = LoggerFactory.getLogger("StoreCustomerVendorApiKeyRoute")

fun Route.registerStoreApiKeyRoutes(
    customerProfileService: CustomerProfileService,
    aiModelsService: AIModelsService
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
