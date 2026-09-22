package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.models.api.CustomerTool
import com.genflowly.models.api.DryRunCustomerToolRequest
import com.genflowly.models.api.DryRunCustomerToolResponse
import com.genflowly.models.api.ErrorResponse
import com.genflowly.models.api.ListCustomerToolsResponse
import com.genflowly.models.api.UpsertCustomerToolRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.CustomerToolsService
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

private val logger = LoggerFactory.getLogger("CustomerToolsRoute")

fun Route.registerCustomerToolsRoutes(
    customerToolsService: CustomerToolsService,
    customerProfileService: CustomerProfileService
) {
    authenticate("auth0", "apiKey") {

        get(Routes.TOOLS, {
            tags("Customer Tools")
            summary = "List the customer's declarative HTTP tools"
            description = "Returns every tool the customer has defined, draft ones included. " +
                    "Rows never contain credential values — only the credentialRef pointing at them."
            response {
                code(HttpStatusCode.OK) {
                    description = "The customer's tools"
                    body<ListCustomerToolsResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val response = customerToolsService.listTools(customerId)
            call.respond(response)
        }

        post(Routes.TOOLS, {
            tags("Customer Tools")
            summary = "Create or replace a declarative HTTP tool"
            description = "The tool name is its identity: posting an existing name replaces that " +
                    "tool and bumps its version. The url's scheme and host must be literal."
            request {
                body<UpsertCustomerToolRequest> {
                    description = "The full tool definition"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The stored tool"
                    body<CustomerTool>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "The definition failed validation; the message is user-facing"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val request = call.receive<UpsertCustomerToolRequest>()
            logger.info("Saving tool for customerId={} name={}", customerId, request.name)
            try {
                call.respond(customerToolsService.saveTool(customerId, request))
            } catch (e: IllegalArgumentException) {
                logger.info("Rejected tool '{}' for customerId={}: {}", request.name, customerId, e.message)
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
            }
        }

        get(Routes.TOOL, {
            tags("Customer Tools")
            summary = "Get one declarative HTTP tool"
            request {
                pathParameter<String>("name") {
                    description = "Model-facing tool name"
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The tool"
                    body<CustomerTool>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing name"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "No tool with that name"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val name = call.parameters["name"]
                ?: return@get call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Missing name"))
            val tool = customerToolsService.getTool(customerId, name)
                ?: return@get call.respond(
                    HttpStatusCode.NotFound, ErrorResponse(error = "Tool '$name' not found.")
                )
            call.respond(tool)
        }

        delete(Routes.TOOL, {
            tags("Customer Tools")
            summary = "Delete a declarative HTTP tool"
            description = "Deleting a tool does not remove its name from any agent's TOOL_EXECUTOR " +
                    "config; an unknown name is simply not bound at runtime."
            request {
                pathParameter<String>("name") {
                    description = "Model-facing tool name"
                }
            }
            response {
                code(HttpStatusCode.NoContent) {
                    description = "Tool removed"
                }
                code(HttpStatusCode.BadRequest) {
                    description = "Missing name"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val name = call.parameters["name"]
                ?: return@delete call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Missing name"))
            logger.info("Deleting tool for customerId={} name={}", customerId, name)
            customerToolsService.deleteTool(customerId, name)
            call.respond(HttpStatusCode.NoContent)
        }

        post(Routes.TOOL_DRY_RUN, {
            tags("Customer Tools")
            summary = "Test a declarative HTTP tool once"
            description = "Resolves the call template with the supplied sample arguments and runs it " +
                    "once, returning the request that was sent and the text the model would see. " +
                    "Send a definition in the body to test an unsaved draft; omit it to test the " +
                    "stored tool. A successful dry run is what lets a tool leave draft status."
            request {
                pathParameter<String>("name") {
                    description = "Model-facing tool name"
                }
                body<DryRunCustomerToolRequest> {
                    description = "Optional draft definition plus the sample arguments"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "The dry-run result (ok=false carries a user-facing error)"
                    body<DryRunCustomerToolResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "The definition failed validation; the message is user-facing"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.NotFound) {
                    description = "No definition sent and no tool stored under that name"
                    body<ErrorResponse>()
                }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val name = call.parameters["name"]
                ?: return@post call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "Missing name"))
            val request = call.receive<DryRunCustomerToolRequest>()
            logger.info("Dry running tool for customerId={} name={}", customerId, name)
            try {
                call.respond(customerToolsService.dryRunTool(customerId, name, request))
            } catch (e: IllegalArgumentException) {
                logger.info("Rejected dry run of '{}' for customerId={}: {}", name, customerId, e.message)
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(error = "${e.message}"))
            } catch (e: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, ErrorResponse(error = "${e.message}"))
            }
        }
    }
}
