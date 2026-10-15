package com.genflowly.activity.generation

import com.genflowly.ResponseHeaders
import com.genflowly.Routes
import com.genflowly.models.retrieval.NDJSON_KEEPALIVE_INTERVAL_MS
import com.genflowly.models.retrieval.toNdjsonFrame
import com.genflowly.models.retrieval.withKeepalives
import com.genflowly.providers.RunsClient
import com.genflowly.service.ConversationAccessDeniedException
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.requireAuthenticatedCustomerId
import io.github.smiley4.ktoropenapi.get
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.Route
import kotlinx.coroutines.flow.mapNotNull
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("RunActivity")

/**
 * Durable-run client routes: reattach to an in-flight run's stream (reload
 * recovery) and resume a run paused on a human-in-the-loop interrupt.
 *
 * Authorization: the caller must be able to access the conversation whose
 * pending run this is — you may only touch a run that is the current pending run
 * of a conversation you can read/edit. The run frames are the SAME NDJSON wire
 * protocol as generate-text-stream (via StreamChunk.toNdjsonFrame), so the web
 * app reuses its existing stream reader.
 */
fun Route.registerRunRoutes(
    runsClient: RunsClient,
    customerProfileService: CustomerProfileService,
    conversationService: ConversationService,
    /** Silence after which a whitespace-only keepalive line is written. */
    keepaliveIntervalMs: Long = NDJSON_KEEPALIVE_INTERVAL_MS,
) {
    authenticate("auth0", "apiKey") {
        get(Routes.REATTACH_RUN, {
            tags("Generation")
            summary = "Reattach to an in-flight durable run's stream"
            description = "Relays the run's remaining events as the same NDJSON frames as " +
                    "generate-text-stream, replaying from ?fromSeq. Used after a page reload to " +
                    "resume watching a response whose durable run is still generating."
            request {
                queryParameter<String>("conversationId") { description = "Conversation the run belongs to"; required = true }
                queryParameter<Long>("fromSeq") { description = "Resume after this event seq (default 0)"; required = false }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val runId = call.parameters["runId"]
            val conversationId = call.request.queryParameters["conversationId"]
            val fromSeq = call.request.queryParameters["fromSeq"]?.toLongOrNull() ?: 0L
            if (runId.isNullOrBlank() || conversationId.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "runId and conversationId are required"))
                return@get
            }
            val pending = try {
                conversationService.pendingRunIdsIfAccessible(conversationId, customerId)
            } catch (e: ConversationAccessDeniedException) {
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Access denied"))
                return@get
            }
            if (runId !in pending) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "run is not active for this conversation"))
                return@get
            }
            call.response.header(HttpHeaders.CacheControl, "no-cache, no-transform")
            call.response.header(HttpHeaders.Connection, "keep-alive")
            call.response.header(ResponseHeaders.ACCEL_BUFFERING, "no")
            call.respondTextWriter(contentType = ContentType.Text.Plain) {
                try {
                    write(" ")  // heartbeat so the client sees TTFB immediately
                    flush()
                    // Whitespace-only lines while the run is quiet (a tool, a queue
                    // wait, a recovery) keep the reattached stream from being cut.
                    runsClient.streamRun(runId, fromSeq)
                        .mapNotNull { it.toNdjsonFrame() }
                        .withKeepalives(keepaliveIntervalMs)
                        .collect { frame -> write(frame); flush() }
                } catch (e: java.io.IOException) {
                    logger.warn("Reattach stream closed by client: {}", e.message)
                } catch (e: Exception) {
                    logger.error("Error during reattach stream for run {}", runId, e)
                }
            }
        }

        post(Routes.RESUME_RUN, {
            tags("Generation")
            summary = "Resume a durable run paused for human/client input"
            description = "Delivers the reply (raw JSON body) to a run paused on an in-graph " +
                    "interrupt(); the run resumes from its checkpoint."
            request {
                queryParameter<String>("conversationId") { description = "Conversation the run belongs to"; required = true }
            }
        }) {
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            val runId = call.parameters["runId"]
            val conversationId = call.request.queryParameters["conversationId"]
            if (runId.isNullOrBlank() || conversationId.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "runId and conversationId are required"))
                return@post
            }
            val body = call.receiveText()
            val pending = try {
                conversationService.pendingRunIdsIfAccessible(conversationId, customerId)
            } catch (e: ConversationAccessDeniedException) {
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Access denied"))
                return@post
            }
            if (runId !in pending) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "run is not active for this conversation"))
                return@post
            }
            val ok = runsClient.resumeRun(runId, body.ifBlank { "{}" })
            logger.info("Resume run {} by {} -> {}", runId, customerId, ok)
            call.respond(if (ok) HttpStatusCode.OK else HttpStatusCode.InternalServerError, mapOf("resumed" to ok))
        }
    }
}
