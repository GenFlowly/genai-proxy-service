package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.server.auth.authenticate
import io.ktor.server.routing.post
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
        post(Routes.STORE_SUPABASE_CONFIG) {
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
