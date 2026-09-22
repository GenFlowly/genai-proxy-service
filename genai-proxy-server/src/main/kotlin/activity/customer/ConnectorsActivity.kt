package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.api.ConnectMcpConnectorRequest
import com.genflowly.models.api.ConnectMcpConnectorResponse
import com.genflowly.models.api.DeleteConnectorResponse
import com.genflowly.models.api.DiscoverMcpConnectorRequest
import com.genflowly.models.api.DiscoverMcpConnectorResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.ImportConnectorResponse
import com.genflowly.models.api.ImportOpenApiConnectorRequest
import com.genflowly.models.api.ListConnectorsResponse
import com.genflowly.models.api.PreviewOpenApiConnectorRequest
import com.genflowly.models.api.PreviewOpenApiConnectorResponse
import com.genflowly.service.ConnectorsService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.delete
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("ConnectorsRoute")

fun Route.registerConnectorsRoutes(
    connectorsService: ConnectorsService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {

        get(Routes.CONNECTORS, {
            tags("Connectors")
            summary = "List the customer's connectors"
            description = "A connector is one thing the customer connected that yields many tools. " +
                    "There is no connectors table: the list is derived by grouping the customer's " +
                    "tools — an MCP server is one row, an API spec is every row sharing its spec url."
            response {
                code(HttpStatusCode.OK) {
                    description = "The customer's connectors"
                    body<ListConnectorsResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            call.respond(connectorsService.listConnectors(customerId))
        }

        post(Routes.CONNECTOR_OPENAPI_PREVIEW, {
            tags("Connectors")
            summary = "See what tools an API spec would yield"
            description = "Reads the OpenAPI document and returns one ready-to-save record per " +
                    "operation, plus the operations that were skipped and why. Writes nothing — the " +
                    "point of the step is that a human approves the list first. The url is " +
                    "user-supplied, so it is fetched by the retrieval server's hardened client, " +
                    "never by the proxy or the browser."
            request {
                body<PreviewOpenApiConnectorRequest> {
                    description = "The spec url, and the credential name the drafts should reference"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The operations the spec offers (ok=false carries a user-facing error)"
                    body<PreviewOpenApiConnectorResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "The request was unusable; the message is user-facing"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val request = call.receive<PreviewOpenApiConnectorRequest>()
            logger.info("Previewing API spec for customerId={}", customerId)
            try {
                call.respond(connectorsService.previewOpenApi(customerId, request))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
            }
        }

        post(Routes.CONNECTOR_OPENAPI_IMPORT, {
            tags("Connectors")
            summary = "Import the chosen operations as draft tools"
            description = "All-or-nothing: every generated tool is validated first and, if any fails, " +
                    "nothing is saved and the error names the operations that failed. Saved tools are " +
                    "drafts — a tool still earns active status through its own dry run."
            request {
                body<ImportOpenApiConnectorRequest> {
                    description = "The spec url, the credential name, and the operations to import"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The connector and the drafts it created"
                    body<ImportConnectorResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "One or more operations failed validation; nothing was saved"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val request = call.receive<ImportOpenApiConnectorRequest>()
            logger.info(
                "Importing {} operations for customerId={}", request.operations.size, customerId
            )
            try {
                call.respond(connectorsService.importOpenApi(customerId, request))
            } catch (e: IllegalArgumentException) {
                logger.info("Rejected connector import for customerId={}: {}", customerId, e.message)
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
            }
        }

        post(Routes.CONNECTOR_MCP_DISCOVER, {
            tags("Connectors")
            summary = "See what tools an MCP server offers"
            description = "Connects to the server once and returns its tool manifest for the customer " +
                    "to approve. Writes nothing. Credential values are never accepted here — headers " +
                    "carry {{credential.some_key}} and the value is resolved server-side."
            request {
                body<DiscoverMcpConnectorRequest> {
                    description = "The server url, the credential name, and any connection headers"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The server's manifest (ok=false carries a user-facing error)"
                    body<DiscoverMcpConnectorResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "The request was unusable; the message is user-facing"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val request = call.receive<DiscoverMcpConnectorRequest>()
            logger.info("Discovering MCP server for customerId={}", customerId)
            try {
                call.respond(connectorsService.discoverMcp(customerId, request))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
            }
        }

        post(Routes.CONNECTOR_MCP_CONNECT, {
            tags("Connectors")
            summary = "Connect an MCP server with the manifest the customer approved"
            description = "Saves one tool row with provider mcp and the approved manifest pinned. " +
                    "The manifest is taken from this request rather than rediscovered: what the agent " +
                    "is later told must be what a human read, so a server that has changed its answer " +
                    "is re-approved rather than silently accepted."
            request {
                body<ConnectMcpConnectorRequest> {
                    description = "The server url, the tool name to save it under, and the approved tools"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The connector and the row it created"
                    body<ConnectMcpConnectorResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "The definition failed validation; the message is user-facing"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val request = call.receive<ConnectMcpConnectorRequest>()
            logger.info("Connecting MCP server for customerId={}", customerId)
            try {
                call.respond(connectorsService.connectMcp(customerId, request))
            } catch (e: IllegalArgumentException) {
                logger.info("Rejected MCP connect for customerId={}: {}", customerId, e.message)
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
            }
        }

        delete(Routes.CONNECTOR, {
            tags("Connectors")
            summary = "Disconnect a connector and delete every tool it produced"
            description = "Removing a tool does not remove its name from any agent's TOOL_EXECUTOR " +
                    "config; an unknown name is simply not bound at runtime."
            request {
                pathParameter<String>("id") {
                    description = "Connector id: the tool name for an MCP server, a slug of the spec url otherwise"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "How many tools were removed"
                    body<DeleteConnectorResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing id"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "No connector with that id"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val id = call.parameters["id"]
                ?: return@delete call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Missing id"))
            logger.info("Disconnecting connector for customerId={} id={}", customerId, id)
            try {
                call.respond(connectorsService.deleteConnector(customerId, id))
            } catch (e: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "${e.message}"))
            }
        }
    }
}
