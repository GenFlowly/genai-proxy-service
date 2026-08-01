package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.GraphService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import models.api.CreateGraphNodeRequest
import models.api.GraphNodeListResponse
import models.api.GraphNodeVersionListResponse
import models.api.UpdateGraphNodeRequest
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("GraphNodeActivity")

fun Route.registerGraphNodeRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0") {

        post(Routes.GRAPH_NODES) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val req = call.receive<CreateGraphNodeRequest>()
                val response = graphService.createGraphNode(customerId, req)
                call.respond(HttpStatusCode.Created, response)
            } catch (e: Exception) {
                logger.error("Failed to create graph node", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        get(Routes.GRAPH_NODES) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val nodes = graphService.listGraphNodes(customerId)
                call.respond(GraphNodeListResponse(nodes))
            } catch (e: Exception) {
                logger.error("Failed to list graph nodes", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        get(Routes.GRAPH_NODE) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val nodeId = call.parameters["nodeId"] ?: return@get call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing nodeId"))
                val node = graphService.getGraphNode(customerId, nodeId)
                call.respond(node)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to get graph node", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        put(Routes.GRAPH_NODE) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val nodeId = call.parameters["nodeId"] ?: return@put call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing nodeId"))
                val req = call.receive<UpdateGraphNodeRequest>()
                val updated = graphService.updateGraphNode(customerId, nodeId, req)
                call.respond(updated)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to update graph node", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        delete(Routes.GRAPH_NODE) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val nodeId = call.parameters["nodeId"] ?: return@delete call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing nodeId"))
                graphService.deleteGraphNode(customerId, nodeId)
                call.respond(HttpStatusCode.NoContent)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to delete graph node", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        get(Routes.GRAPH_NODE_VERSIONS) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val nodeId = call.parameters["nodeId"] ?: return@get call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing nodeId"))
                val versions = graphService.getGraphNodeVersions(customerId, nodeId)
                call.respond(GraphNodeVersionListResponse(nodeId = nodeId, versions = versions))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to get graph node versions", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        post(Routes.GRAPH_NODE_ROLLBACK) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val nodeId = call.parameters["nodeId"] ?: return@post call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing nodeId"))
                val version = call.parameters["version"]?.toIntOrNull() ?: return@post call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing or invalid version"))
                val updated = graphService.rollbackGraphNode(customerId, nodeId, version)
                call.respond(updated)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to rollback graph node", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }
    }
}
