package com.genflowly.activity.agent

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.GetNodePresetsResponse
import com.genflowly.models.api.NodePreset
import com.genflowly.models.api.UpsertNodePresetRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.NodePresetService
import com.genflowly.utils.requireAdminCustomerId
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.github.smiley4.ktoropenapi.put
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.SerializationException
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("NodePresetsActivity")

/**
 * Pre-made nodes for the graph editor palette. Listing is customer-facing —
 * every user's palette is built from it; create/update/delete are admin-only
 * (same allowlist posture as the default-graph endpoints).
 */
fun Route.registerNodePresetRoutes(
    nodePresetService: NodePresetService,
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig,
) {
    authenticate("auth0", "apiKey") {
        get(Routes.NODE_PRESETS, {
            tags("Agents")
            summary = "List the pre-made nodes for the graph editor palette"
            response {
                code(HttpStatusCode.OK) { body<GetNodePresetsResponse>() }
                code(HttpStatusCode.InternalServerError) { body<ErrorResponse>() }
            }
        }) {
            try {
                call.requireAuthenticatedCustomerId(customerProfileService)
                call.respond(nodePresetService.listPresets())
            } catch (e: Exception) {
                logger.error("Failed to list node presets", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }
    }

    authenticate("auth0") {
        post(Routes.ADMIN_NODE_PRESETS, { hidden = true }) {
            try {
                val adminId = call.requireAdminCustomerId(customerProfileService, appConfig)
                val req = call.receive<UpsertNodePresetRequest>()
                try {
                    logger.info("Admin {} creating node preset '{}'", adminId, req.name)
                    call.respond(nodePresetService.createPreset(req))
                } catch (e: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
                }
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to create node preset", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        put(Routes.ADMIN_NODE_PRESET, { hidden = true }) {
            val presetId = call.parameters["presetId"] ?: return@put call.respond(
                HttpStatusCode.BadRequest, ErrorResponse(error = "Missing presetId")
            )
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                val req = call.receive<UpsertNodePresetRequest>()
                try {
                    call.respond(nodePresetService.updatePreset(presetId, req))
                } catch (e: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
                } catch (e: IllegalStateException) {
                    call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "${e.message}"))
                }
            } catch (e: SerializationException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Invalid request format"))
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to update node preset $presetId", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }

        delete(Routes.ADMIN_NODE_PRESET, { hidden = true }) {
            val presetId = call.parameters["presetId"] ?: return@delete call.respond(
                HttpStatusCode.BadRequest, ErrorResponse(error = "Missing presetId")
            )
            try {
                call.requireAdminCustomerId(customerProfileService, appConfig)
                try {
                    nodePresetService.deletePreset(presetId)
                    call.respond(HttpStatusCode.NoContent)
                } catch (e: IllegalStateException) {
                    call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "${e.message}"))
                }
            } catch (e: IllegalStateException) {
                // requireAdminCustomerId already responded (403)
            } catch (e: Exception) {
                logger.error("Failed to delete node preset $presetId", e)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error = "Internal server error"))
            }
        }
    }
}
