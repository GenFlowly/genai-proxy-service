package com.genflowly.activity.admin

import com.genflowly.Routes
import com.genflowly.models.api.ErrorResponse
import com.genflowly.config.AppConfig
import com.genflowly.service.AIModelsService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.SystemApiKeyService
import com.genflowly.utils.requireAdminCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import com.genflowly.models.GetSystemVendorApiKeyStatusListResponse
import com.genflowly.models.StoreSystemVendorApiKeyRequest
import com.genflowly.models.StoreSystemVendorApiKeyResponse
import com.genflowly.models.StoreSystemVendorConfigRequest
import com.genflowly.models.SystemVendorModelsResponse
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("SystemVendorApiKeysActivity")

/**
 * Admin-panel endpoints for the system-wide AI vendor API keys.
 *
 * Deliberately JWT-only (a developer API key must never manage system keys),
 * gated by the ADMIN_EMAILS / ADMIN_CUSTOMER_IDS allowlist, and hidden from
 * the public OpenAPI spec.
 */
fun Route.registerSystemVendorApiKeysRoutes(
    systemApiKeyService: SystemApiKeyService,
    customerProfileService: CustomerProfileService,
    aiModelsService: AIModelsService,
    appConfig: AppConfig,
    modelCatalogService: com.genflowly.service.ModelCatalogService
) {
    authenticate("auth0") {
        // Rebuild the AIModelCatalog table on demand (it also refreshes daily),
        // e.g. right after a new system key is stored or a vendor ships a model.
        post(Routes.ADMIN_MODEL_CATALOG_REFRESH, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                logger.info("Admin {} triggering model catalog refresh", customerId)
                val counts = modelCatalogService.refreshCatalog()
                call.respond(mapOf("modelsStored" to counts.mapValues { it.value.toString() }))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to refresh model catalog", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }

        post(Routes.ADMIN_SYSTEM_API_KEYS, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val request = call.receive<StoreSystemVendorApiKeyRequest>()

                val aiVendor = try {
                    com.genflowly.aicallerlib.models.AIVendor.valueOf(request.aiVendor)
                } catch (e: IllegalArgumentException) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Unknown AI vendor: ${request.aiVendor}")
                    )
                }

                logger.info("Admin {} storing system API key for vendor {}", customerId, aiVendor)

                // Validate against the vendor before storing; invalid keys are rejected
                val apiKeyStatus = systemApiKeyService.validateAndStoreSystemKey(
                    vendor = aiVendor,
                    apiKey = request.apiKey,
                    updatedBy = customerId
                )
                call.respond(StoreSystemVendorApiKeyResponse(apiKeyStatus = apiKeyStatus))
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to store system API key", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }

        get(Routes.ADMIN_SYSTEM_API_KEYS, { hidden = true }) {
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                val statuses = systemApiKeyService.getSystemApiKeyStatusList()
                call.respond(GetSystemVendorApiKeyStatusListResponse(apiKeyStatuses = statuses))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to list system API key statuses", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }

        get(Routes.ADMIN_SYSTEM_API_KEY_MODELS, { hidden = true }) {
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                val vendorParam = call.parameters["aiVendor"]
                    ?: return@get call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Missing aiVendor")
                    )

                val aiVendor = try {
                    com.genflowly.aicallerlib.models.AIVendor.valueOf(vendorParam)
                } catch (e: IllegalArgumentException) {
                    return@get call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Unknown AI vendor: $vendorParam")
                    )
                }

                val apiKey = systemApiKeyService.getSystemApiKeyForVendor(aiVendor)
                    ?: return@get call.respond(
                        HttpStatusCode.NotFound,
                        ErrorResponse(error = "No system API key stored for vendor $vendorParam")
                    )

                val modelList = aiModelsService.getModelsWithApiKey(aiVendor, apiKey)
                call.respond(
                    SystemVendorModelsResponse(
                        aiVendor = aiVendor,
                        models = modelList.modelsList
                    )
                )
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to list models for system API key", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }

        post(Routes.ADMIN_SYSTEM_API_KEY_CONFIG, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val request = call.receive<StoreSystemVendorConfigRequest>()

                val aiVendor = try {
                    com.genflowly.aicallerlib.models.AIVendor.valueOf(request.aiVendor)
                } catch (e: IllegalArgumentException) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Unknown AI vendor: ${request.aiVendor}")
                    )
                }

                if (request.model.isBlank()) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Model must not be blank")
                    )
                }
                if (request.priority < 1) {
                    return@post call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Priority must be >= 1")
                    )
                }

                logger.info(
                    "Admin {} setting system config for vendor {}: model={} priority={}",
                    customerId, aiVendor, request.model, request.priority
                )
                try {
                    systemApiKeyService.updateSystemVendorConfig(aiVendor.name, request.model, request.priority)
                } catch (e: software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException) {
                    return@post call.respond(
                        HttpStatusCode.Conflict,
                        ErrorResponse(error = "No system API key stored for vendor ${aiVendor.name}")
                    )
                }
                call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to store system vendor config", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }

        delete(Routes.ADMIN_SYSTEM_API_KEY, { hidden = true }) {
            try {
                val customerId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val vendorParam = call.parameters["aiVendor"]
                    ?: return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Missing aiVendor")
                    )

                val aiVendor = try {
                    com.genflowly.aicallerlib.models.AIVendor.valueOf(vendorParam)
                } catch (e: IllegalArgumentException) {
                    return@delete call.respond(
                        HttpStatusCode.BadRequest,
                        ErrorResponse(error = "Unknown AI vendor: $vendorParam")
                    )
                }

                logger.info("Admin {} deleting system API key for vendor {}", customerId, aiVendor)
                systemApiKeyService.deleteSystemApiKey(aiVendor.name)
                call.respond(HttpStatusCode.NoContent)
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to delete system API key", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ErrorResponse(error = "Internal server error")
                )
            }
        }
    }
}
