package com.genflowly.activity.generation

import com.genflowly.Routes
import com.genflowly.models.api.GetTextGenerationModelsRequest
import com.genflowly.models.api.GetTextGenerationModelsResponse
import com.genflowly.service.AIModelsService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory
import com.genflowly.service.CustomerProfileService

private val logger = LoggerFactory.getLogger("GetTextGenerationModelsRoute")

fun Route.registerGetTextGenerationModelsRoutes(
    aiModelsService: AIModelsService,
    customerProfileService: CustomerProfileService,
    vendorAllowlistService: com.genflowly.service.VendorAllowlistService
) {

    authenticate("auth0", "apiKey") {
        get(Routes.GET_TEXT_GENERATION_MODELS, {
            tags("Generation")
            summary = "List available text-generation models"
            description = "Returns the models available to the customer for the requested AI " +
                    "vendors, based on the API keys the customer has stored."
            request {
                queryParameter<String>("vendors") {
                    description = "Comma-separated AI vendors to list models for"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Models grouped by AI vendor"
                    body<GetTextGenerationModelsResponse>()
                }
            }
        }) {
            val vendors = call.request.queryParameters["vendors"]
                ?.split(',')
                ?.map { it.trim() }
                ?.filter { it.isNotEmpty() }
                ?.map { com.genflowly.models.AIVendor.of(it) }
                .orEmpty()

            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

            call.respond(
                GetTextGenerationModelsResponse(
                    aiVendorModelList = aiModelsService.getModelsForVendors(vendors, customerId)
                )
            )
        }

        // Legacy body-based variant of the read above. The frontend moved to
        // the GET form; delete this once no deployed client sends it.
        post(Routes.GET_TEXT_GENERATION_MODELS, {
            tags("Generation")
            summary = "List available text-generation models (deprecated POST form)"
            description = "Deprecated: use GET /models?vendors=a,b. Same response."
            request {
                body<GetTextGenerationModelsRequest> {
                    description = "AI vendors to list models for"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Models grouped by AI vendor"
                    body<GetTextGenerationModelsResponse>()
                }
            }
        }) {
            val request = call.receive<GetTextGenerationModelsRequest>()
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)

            call.respond(
                GetTextGenerationModelsResponse(
                    aiVendorModelList = aiModelsService.getModelsForVendors(request.aiVendor, customerId)
                )
            )
        }

        get(Routes.PROVIDERS, {
            tags("Generation")
            summary = "BYOK vendor catalog"
            description = "Every AI provider the platform can call — the native langchain tier " +
                    "plus the LiteLLM long tail — with chat models and per-model tool-calling " +
                    "support. Any listed provider works once the customer stores an API key."
            response {
                code(HttpStatusCode.OK) {
                    description = "Providers with their models"
                    body<com.genflowly.models.api.ProviderCatalogResponse>()
                }
            }
        }) {
            call.requireAuthenticatedCustomerId(customerProfileService)
            // Customers only see admin-allowlisted vendors; the unfiltered
            // catalog is admin-panel-only (GET /admin/vendor-allowlist).
            val catalog = aiModelsService.getProviderCatalog()
            val allowed = vendorAllowlistService.getAllowedProviderIds()
            call.respond(
                if (allowed == null) catalog
                else catalog.copy(providers = catalog.providers.filter { it.id in allowed })
            )
        }
    }
}
