package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.GetCustomerEmbeddingKeysResponse
import com.genflowly.models.GetEmbeddingModelsResponse
import com.genflowly.models.StoreCustomerEmbeddingKeyRequest
import com.genflowly.models.StoreCustomerEmbeddingKeyResponse
import com.genflowly.service.CustomerCredentialsService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CustomerEmbeddingKeysActivity")

fun Route.registerEmbeddingKeyRoutes(
    customerCredentialsService: CustomerCredentialsService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        get(Routes.EMBEDDING_KEYS, {
            tags("Customer")
            summary = "Embedding API key status per provider"
            description = "Key status for every embedding provider (OpenAI, Voyage). The OpenAI " +
                    "key is shared with the text-generation vendor of the same name, so a key " +
                    "stored on either page reads as set on both."
            response {
                code(HttpStatusCode.OK) {
                    description = "Status per embedding provider"
                    body<GetCustomerEmbeddingKeysResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val statuses = customerCredentialsService.getEmbeddingKeyStatuses(customerId)
            call.respond(GetCustomerEmbeddingKeysResponse(statuses = statuses))
        }

        get(Routes.EMBEDDING_MODELS, {
            tags("Customer")
            summary = "Available embedding models per provider"
            description = "Embedding models the customer can set as their default, grouped by " +
                    "provider. Only providers whose API key is stored are listed."
            response {
                code(HttpStatusCode.OK) {
                    description = "Embedding models per provider with a stored key"
                    body<GetEmbeddingModelsResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val vendorModels = customerCredentialsService.getEmbeddingModels(customerId)
            call.respond(GetEmbeddingModelsResponse(vendorModels = vendorModels))
        }

        post(Routes.STORE_EMBEDDING_KEY, {
            tags("Customer")
            summary = "Store an embedding provider API key"
            description = "Validates the key against the provider and stores it encrypted if " +
                    "valid. Invalid keys are not stored; the response reports the validation " +
                    "status either way."
            request {
                body<StoreCustomerEmbeddingKeyRequest> {
                    description = "Embedding provider and the API key to store"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Validation and storage status of the key"
                    body<StoreCustomerEmbeddingKeyResponse>()
                }
            }
        }) {
            val request = call.receive<StoreCustomerEmbeddingKeyRequest>()
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

            logger.info("Received StoreCustomerEmbeddingKeyRequest from customerId {} for vendor {}", customerId, request.vendor)

            val keyStatus = customerCredentialsService.validateAndStoreEmbeddingKey(
                customerId = customerId,
                vendor = request.vendor,
                apiKey = request.apiKey
            )
            call.respond(StoreCustomerEmbeddingKeyResponse(keyStatus = keyStatus))
        }
    }
}
