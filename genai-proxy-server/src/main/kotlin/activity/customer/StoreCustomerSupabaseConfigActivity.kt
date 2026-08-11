package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import models.StoreCustomerSupabaseConfigRequest
import models.StoreCustomerSupabaseConfigResponse
import models.SupabaseConfigStatus
import models.SupabaseConfigStatusValue
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("StoreCustomerSupabaseConfigActivity")

fun Route.registerStoreSupabaseConfigRoutes(
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0") {
        post(Routes.STORE_SUPABASE_CONFIG, {
            tags("Customer")
            summary = "Store a Supabase configuration"
            description = "Stores the customer's Supabase endpoint, token and password."
            request {
                body<StoreCustomerSupabaseConfigRequest> {
                    description = "Supabase endpoint, token and password"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Storage status of the configuration"
                    body<StoreCustomerSupabaseConfigResponse>()
                }
            }
        }) {
            val request = call.receive<StoreCustomerSupabaseConfigRequest>()
            
            // Extract customerId from JWT token
            val customerId = call.requireAuthenticatedCustomerId(
                customerProfileService
            )
            
            logger.info("Received StoreCustomerSupabaseConfigRequest from customerId {}", customerId)

            val stored = customerProfileService.storeCustomerSupabaseConfig(
                customerId = customerId,
                endpoint = request.endpoint,
                token = request.token,
                password = request.password
            )
            
            logger.info("Supabase Config stored: {}", stored)

            val response = StoreCustomerSupabaseConfigResponse(
                configStatus = SupabaseConfigStatus(
                    isConfigValid = true,
                    status = SupabaseConfigStatusValue.PRESENT,
                    updateSuccessful = true
                )
            )
            call.respond(response)
        }
    }
}
