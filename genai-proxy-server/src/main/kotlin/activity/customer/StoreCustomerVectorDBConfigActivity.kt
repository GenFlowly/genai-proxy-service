package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import models.StoreCustomerVectorDBConfigRequest
import models.StoreCustomerVectorDBConfigResponse
import models.VectorDBConfigStatus
import models.VectorDBConfigStatusValue
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("StoreCustomerVectorDBConfigActivity")

fun Route.registerStoreVectorDBConfigRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {
        post(Routes.STORE_VECTOR_DB_CONFIG, {
            tags("Customer")
            summary = "Store a vector DB configuration"
            description = "Stores the customer's vector database endpoint and token for the given vendor."
            request {
                body<StoreCustomerVectorDBConfigRequest> {
                    description = "Vector DB vendor, endpoint and token"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Storage status of the configuration"
                    body<StoreCustomerVectorDBConfigResponse>()
                }
            }
        }) {
            val request = call.receive<StoreCustomerVectorDBConfigRequest>()
            
            // Extract customerId from JWT token
            val customerId = call.requireAuthenticatedCustomerId(
                customerProfileService
            )
            
            logger.info("Received StoreCustomerVectorDBConfigRequest from customerId {}: vendor={}", customerId, request.vendor)

            val vendor = request.vendor

            val stored = customerProfileService.storeCustomerVectorDBConfig(
                customerId = customerId,
                vendor = vendor,
                endpoint = request.endpoint,
                token = request.token
            )
            
            logger.info("Vector DB Config stored for vendor {}: {}", vendor, stored)

            val response = StoreCustomerVectorDBConfigResponse(
                configStatus = VectorDBConfigStatus(
                    vendor = vendor,
                    isConfigValid = true,
                    status = VectorDBConfigStatusValue.PRESENT,
                    updateSuccessful = true
                )
            )
            call.respond(response)
        }
    }
}
