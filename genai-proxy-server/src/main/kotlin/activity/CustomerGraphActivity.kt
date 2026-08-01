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
import models.api.CreateCustomerGraphRequest
import models.api.CustomerGraphListResponse
import models.api.CustomerGraphVersionListResponse
import models.api.UpdateCustomerGraphRequest
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CustomerGraphActivity")

fun Route.registerCustomerGraphRoutes(
    graphService: GraphService,
    customerProfileService: CustomerProfileService,
) {
    authenticate("auth0") {

        post(Routes.GRAPHS) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val req = call.receive<CreateCustomerGraphRequest>()
                val response = graphService.createGraph(customerId, req)
                call.respond(HttpStatusCode.Created, response)
            } catch (e: Exception) {
                logger.error("Failed to create graph", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        get(Routes.GRAPHS) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val graphs = graphService.listGraphs(customerId)
                call.respond(CustomerGraphListResponse(graphs))
            } catch (e: Exception) {
                logger.error("Failed to list graphs", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        get(Routes.GRAPH) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val graphId = call.parameters["graphId"] ?: return@get call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing graphId"))
                val graph = graphService.getGraph(customerId, graphId)
                call.respond(graph)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to get graph", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        put(Routes.GRAPH) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val graphId = call.parameters["graphId"] ?: return@put call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing graphId"))
                val req = call.receive<UpdateCustomerGraphRequest>()
                val updated = graphService.updateGraph(customerId, graphId, req)
                call.respond(updated)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to update graph", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        delete(Routes.GRAPH) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val graphId = call.parameters["graphId"] ?: return@delete call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing graphId"))
                graphService.deleteGraph(customerId, graphId)
                call.respond(HttpStatusCode.NoContent)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to delete graph", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        get(Routes.GRAPH_VERSIONS) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val graphId = call.parameters["graphId"] ?: return@get call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing graphId"))
                val versions = graphService.getGraphVersions(customerId, graphId)
                call.respond(CustomerGraphVersionListResponse(graphId = graphId, versions = versions))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to get graph versions", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }

        post(Routes.GRAPH_ROLLBACK) {
            try {
                val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
                val graphId = call.parameters["graphId"] ?: return@post call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing graphId"))
                val version = call.parameters["version"]?.toIntOrNull() ?: return@post call.respond(
                    HttpStatusCode.BadRequest, mapOf("error" to "Missing or invalid version"))
                val updated = graphService.rollbackGraph(customerId, graphId, version)
                call.respond(updated)
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to e.message))
            } catch (e: Exception) {
                logger.error("Failed to rollback graph", e)
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
            }
        }
    }
}
