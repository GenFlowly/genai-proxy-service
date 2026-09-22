package com.genflowly.service

import com.genflowly.models.api.ConnectMcpConnectorRequest
import com.genflowly.models.api.ConnectMcpConnectorResponse
import com.genflowly.models.api.Connector
import com.genflowly.models.api.ConnectorOperation
import com.genflowly.models.api.CustomerTool
import com.genflowly.models.api.DeleteConnectorResponse
import com.genflowly.models.api.DiscoverMcpConnectorRequest
import com.genflowly.models.api.DiscoverMcpConnectorResponse
import com.genflowly.models.api.ImportConnectorResponse
import com.genflowly.models.api.ImportOpenApiConnectorRequest
import com.genflowly.models.api.ListConnectorsResponse
import com.genflowly.models.api.McpConnectorTool
import com.genflowly.models.api.PreviewOpenApiConnectorRequest
import com.genflowly.models.api.PreviewOpenApiConnectorResponse
import com.genflowly.models.api.UpsertCustomerToolRequest
import com.genflowly.repository.CustomerToolsRepository
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import java.security.MessageDigest
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Connectors: one thing the customer connects, many tools out.
 *
 * Two things about this class are worth knowing before changing it.
 *
 * **It owns no storage.** A connector is derived by grouping `CustomerTools`
 * rows — an mcp row is a connector by itself, openapi rows are a connector when
 * they share an `originRef`. A connector therefore cannot drift out of sync
 * with the tools it claims to have produced, because it *is* those tools.
 *
 * **It never fetches the customer's url.** Both the spec url and the MCP server
 * url are user-supplied, so both are handed to the retrieval server's
 * SSRF-hardened client. The preview and discover steps write nothing at all:
 * they exist so a human can read what they are about to give an agent, and only
 * the second call — import or connect — persists anything.
 *
 * Rejection messages are written to be shown to a user verbatim by the UI.
 */
class ConnectorsService(
    private val customerToolsRepository: CustomerToolsRepository,
    private val json: Json,
    private val httpClient: HttpClient,
    private val retrievalServerUrl: String,
) {

    // ── Listing: connectors derived from the rows that already exist ──────────

    suspend fun listConnectors(customerId: String): ListConnectorsResponse =
        ListConnectorsResponse(connectors = deriveConnectors(customerToolsRepository.listCustomerTools(customerId)))

    // ── OpenAPI: preview (writes nothing) then import ─────────────────────────

    /**
     * Ask the retrieval server what tools a spec would yield. Nothing is stored:
     * this is the screen the customer reads before deciding.
     *
     * An unreachable or unhappy retrieval server becomes `ok = false` with a
     * user-facing message rather than an exception, exactly as a dry run does.
     */
    suspend fun previewOpenApi(
        customerId: String,
        request: PreviewOpenApiConnectorRequest,
    ): PreviewOpenApiConnectorResponse {
        val specUrl = request.specUrl.trim()
        require(specUrl.isNotBlank()) { "Paste the API's OpenAPI document url to see what it offers." }

        val payload = wireJson.encodeToString(
            OpenApiPreviewPayload(
                customer_id = customerId,
                spec_url = specUrl,
                credential_ref = request.credentialRef.trim(),
            )
        )
        return forward(
            path = "/connectors/openapi/preview",
            payload = payload,
            onFailure = { message -> PreviewOpenApiConnectorResponse(ok = false, error = message) },
        )
    }

    /**
     * Turn the ticked operations into draft tools.
     *
     * All-or-nothing on validation: every generated row goes through
     * [CustomerToolValidator] first and, if any fails, nothing is written and
     * the message names each operation that failed and why. Half an import is
     * worse than none — the customer approved a set, not a subset, and the
     * connector's tool count would no longer describe what they saw.
     *
     * Rows are saved as `draft`: a tool still earns `active` through its own
     * dry run, which import deliberately does not perform (importing twenty
     * operations must not fire twenty calls at somebody's API).
     *
     * @throws IllegalArgumentException with a user-facing message (→ HTTP 400).
     */
    suspend fun importOpenApi(
        customerId: String,
        request: ImportOpenApiConnectorRequest,
    ): ImportConnectorResponse {
        val specUrl = request.specUrl.trim()
        require(specUrl.isNotBlank()) { "The import is missing the spec url the operations came from." }
        require(request.operations.isNotEmpty()) {
            "No operations were selected, so there is nothing to import."
        }
        require(request.operations.size <= MAX_IMPORTED_OPERATIONS) {
            "You selected ${request.operations.size} operations; at most $MAX_IMPORTED_OPERATIONS can be " +
                "imported at once. Every tool's description is placed in the model's context, so a long " +
                "list costs the agent more than it gives it."
        }

        // The name is the sort key, so two operations sharing one would
        // silently overwrite each other instead of importing.
        val duplicates = request.operations
            .groupBy { it.name.trim() }
            .filterValues { it.size > 1 }
            .keys
        require(duplicates.isEmpty()) {
            "Nothing was imported: these tool names appear more than once in the selection — " +
                "${duplicates.sorted().joinToString(", ")}. Each tool needs its own name."
        }

        val credentialRef = request.credentialRef.trim()
        val drafts = request.operations.map { operation -> operation to operation.toDraft(specUrl, credentialRef) }

        val failures = drafts.mapNotNull { (operation, draft) ->
            try {
                CustomerToolValidator.validate(draft)
                null
            } catch (e: IllegalArgumentException) {
                operation.label() to (e.message ?: "The generated tool definition is not valid.")
            }
        }
        require(failures.isEmpty()) {
            "Nothing was imported: ${failures.size} of ${drafts.size} selected operation" +
                (if (drafts.size == 1) "" else "s") + " could not be turned into a tool. " +
                failures.joinToString(" ") { (name, reason) -> "$name — $reason" }
        }

        val saved = drafts.map { (_, draft) -> persist(customerId, draft) }
        logger.info { "Imported ${saved.size} draft tools from $specUrl for customer $customerId" }

        return ImportConnectorResponse(
            connector = specConnector(specUrl, saved),
            tools = saved,
        )
    }

    // ── MCP: discover (writes nothing) then connect ───────────────────────────

    /**
     * Ask the retrieval server what an MCP server offers. Nothing is stored;
     * the customer approves the list, and that approval is what `connect` pins.
     */
    suspend fun discoverMcp(
        customerId: String,
        request: DiscoverMcpConnectorRequest,
    ): DiscoverMcpConnectorResponse {
        val serverUrl = request.serverUrl.trim()
        require(serverUrl.isNotBlank()) { "Paste the MCP server's url to see the tools it offers." }
        requireNoCredentialValues(request.headers)

        val payload = wireJson.encodeToString(
            McpDiscoverPayload(
                customer_id = customerId,
                server_url = serverUrl,
                credential_ref = request.credentialRef.trim(),
                headers = request.headers,
            )
        )
        return forward(
            path = "/connectors/mcp/discover",
            payload = payload,
            onFailure = { message -> DiscoverMcpConnectorResponse(ok = false, error = message) },
        )
    }

    /**
     * Save the approved server as one `provider: "mcp"` row with its manifest
     * pinned in [CustomerTool.discoveredTools].
     *
     * The manifest comes from the request rather than from a fresh discovery
     * call on purpose: a tool description is text placed straight into the
     * model's context, so what the agent is told must be what a human read. A
     * server that has changed its answer since the discover step gets
     * re-approved, not silently accepted.
     *
     * @throws IllegalArgumentException with a user-facing message (→ HTTP 400).
     */
    suspend fun connectMcp(
        customerId: String,
        request: ConnectMcpConnectorRequest,
    ): ConnectMcpConnectorResponse {
        val serverUrl = request.serverUrl.trim()
        require(serverUrl.isNotBlank()) { "Paste the MCP server's url before connecting it." }
        requireNoCredentialValues(request.headers)
        require(request.tools.isNotEmpty()) {
            "Approve at least one of the server's tools before connecting it — a server with an empty " +
                "list would give the agent nothing."
        }

        val label = request.label.trim().ifBlank { labelFor(serverUrl) }
        val draft = UpsertCustomerToolRequest(
            name = request.name.trim().ifBlank { toolNameFrom(label, serverUrl) },
            description = request.description.trim().ifBlank { describedBy(label, serverUrl, request.tools.size) },
            // An mcp record describes a server; each discovered tool carries its
            // own argument schema, so there is no shared `parameters` here.
            parameters = "",
            provider = "mcp",
            request = mcpRequestTemplate(serverUrl, request.headers),
            credentialRef = request.credentialRef.trim(),
            responseTransform = "",
            discoveredTools = manifestOf(request.tools),
            status = "draft",
            // `origin` only distinguishes hand-written from spec-generated rows;
            // an MCP server came from neither a spec nor a generator, so it
            // keeps the default. `originRef` still records where it came from.
            origin = "manual",
            originRef = serverUrl,
        )
        CustomerToolValidator.validate(draft)

        val saved = persist(customerId, draft)
        logger.info {
            "Connected MCP server $serverUrl as '${saved.name}' with ${request.tools.size} approved tools " +
                "for customer $customerId"
        }

        return ConnectMcpConnectorResponse(
            connector = mcpConnector(saved),
            tool = saved,
        )
    }

    /**
     * A model-facing name from what the customer called the connection, so the
     * UI can ask for "Notion" rather than for a sort key. Falls back to the
     * server's host, then to a generic name, and always lands inside the tool
     * name regex — a name that does not is rejected by the validator with a
     * message about a field the customer never filled in.
     */
    private fun toolNameFrom(label: String, serverUrl: String): String {
        val candidates = listOf(label, labelFor(serverUrl), "mcp server")
        for (candidate in candidates) {
            val cleaned = NON_NAME_CHARS.replace(candidate.lowercase(), "_").trim('_')
            val prefixed = if (cleaned.firstOrNull()?.isLetter() == true) cleaned else "mcp_$cleaned"
            val name = prefixed.trim('_').take(64)
            if (NAME_SHAPE.matches(name)) return name
        }
        return "mcp_server"
    }

    private fun describedBy(label: String, serverUrl: String, toolCount: Int) =
        "The $label tools, from the MCP server at ${labelFor(serverUrl).ifBlank { serverUrl }} " +
            "($toolCount approved ${if (toolCount == 1) "tool" else "tools"})."

    // ── Disconnect ────────────────────────────────────────────────────────────

    /**
     * Remove every tool the connector produced.
     *
     * [DeleteConnectorResponse.removed] counts the tools the customer was shown
     * — manifest entries for an MCP server, rows for a spec — so the number in
     * the confirmation matches the number in the listing.
     *
     * @throws IllegalStateException when no connector has that id (→ HTTP 404).
     */
    suspend fun deleteConnector(customerId: String, id: String): DeleteConnectorResponse {
        val rows = customerToolsRepository.listCustomerTools(customerId)
        val connector = deriveConnectors(rows).firstOrNull { it.id == id }
            ?: throw IllegalStateException(
                "Connector '$id' not found. It may already have been disconnected."
            )

        val doomed = rowsOf(rows, connector)
        doomed.forEach { customerToolsRepository.deleteCustomerTool(customerId, it.name) }
        logger.info {
            "Disconnected ${connector.kind} connector '$id' for customer $customerId: " +
                "${doomed.size} row(s), ${connector.toolCount} tool(s)"
        }

        return DeleteConnectorResponse(
            id = id,
            removed = connector.toolCount,
            rowsDeleted = doomed.size,
        )
    }

    // ── Deriving connectors from rows ─────────────────────────────────────────

    private fun deriveConnectors(rows: List<CustomerTool>): List<Connector> {
        val mcp = rows.filter { it.isMcp() }.map { mcpConnector(it) }
        val specs = rows.filter { it.isSpecGenerated() }
            .groupBy { it.originRef.trim() }
            .map { (ref, group) -> specConnector(ref, group) }
        // Hand-written tools belong to no connector and are simply not listed.
        return (mcp + specs).sortedWith(compareBy({ it.label.lowercase() }, { it.id }))
    }

    /** The rows that a derived connector is made of — what a delete removes. */
    private fun rowsOf(rows: List<CustomerTool>, connector: Connector): List<CustomerTool> =
        if (connector.kind == "mcp") {
            rows.filter { it.isMcp() && it.name == connector.id }
        } else {
            rows.filter { it.isSpecGenerated() && it.originRef.trim() == connector.ref }
        }

    private fun mcpConnector(row: CustomerTool): Connector {
        val serverUrl = row.mcpServerUrl()
        return Connector(
            id = row.name,
            kind = "mcp",
            label = labelFor(serverUrl).ifBlank { row.name },
            ref = serverUrl,
            toolCount = manifestSize(row.discoveredTools),
            credentialRef = row.credentialRef,
            connectedAt = row.createdAt.orEmpty(),
        )
    }

    private fun specConnector(ref: String, group: List<CustomerTool>) = Connector(
        id = slugFor(ref),
        kind = "openapi",
        label = labelFor(ref).ifBlank { ref },
        ref = ref,
        toolCount = group.size,
        credentialRef = group.firstOrNull { it.credentialRef.isNotBlank() }?.credentialRef.orEmpty(),
        connectedAt = group.mapNotNull { it.createdAt }.minOrNull().orEmpty(),
    )

    private fun CustomerTool.isMcp() = provider == "mcp"

    private fun CustomerTool.isSpecGenerated() =
        provider != "mcp" && origin == "openapi" && originRef.isNotBlank()

    /** The server url an mcp row points at: its request template, else its audit ref. */
    private fun CustomerTool.mcpServerUrl(): String {
        val fromTemplate = runCatching {
            ((parser.parseToJsonElement(request) as? JsonObject)?.get("url") as? JsonPrimitive)?.content
        }.getOrNull()
        return fromTemplate?.takeIf { it.isNotBlank() } ?: originRef
    }

    // ── Saving ────────────────────────────────────────────────────────────────

    /**
     * Write one validated row, preserving the version chain and birth date of a
     * row that already carries the same name — the same contract [saveTool]
     * honours, so importing over an earlier import updates rather than resets.
     */
    private suspend fun persist(customerId: String, draft: UpsertCustomerToolRequest): CustomerTool {
        val existing = customerToolsRepository.getCustomerTool(customerId, draft.name)
        val tool = CustomerTool(
            name = draft.name,
            description = draft.description,
            parameters = draft.parameters,
            provider = draft.provider,
            request = draft.request,
            credentialRef = draft.credentialRef,
            responseTransform = draft.responseTransform,
            discoveredTools = draft.discoveredTools,
            status = draft.status,
            version = (existing?.version ?: 0) + 1,
            origin = draft.origin,
            originRef = draft.originRef,
            lastDryRunAt = draft.lastDryRunAt,
            createdAt = existing?.createdAt ?: Instant.now().toString(),
        )
        customerToolsRepository.saveCustomerTool(customerId, tool)
        return tool
    }

    // ── Forwarding to the retrieval server ────────────────────────────────────

    /**
     * The shared [Json] omits fields that equal their default, which would drop
     * an empty `credential_ref` or `headers` from the wire record. The retrieval
     * server reads the whole payload, so encode every field.
     */
    private val wireJson = Json(json) { encodeDefaults = true }

    private val parser = Json { ignoreUnknownKeys = true; isLenient = true }

    private suspend inline fun <reified T> forward(
        path: String,
        payload: String,
        onFailure: (String) -> T,
    ): T = try {
        val response: HttpResponse = httpClient.post("$retrievalServerUrl$path") {
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        val body = response.bodyAsText()
        if (!response.status.isSuccess()) {
            logger.warn { "Retrieval server $path returned ${response.status}: $body" }
            onFailure("The connector service could not read that url (${response.status}).")
        } else {
            wireJson.decodeFromString<T>(body)
        }
    } catch (e: Exception) {
        logger.warn { "Connector call to $path failed: ${e.message}" }
        onFailure("The connector service is unreachable right now. Please try again.")
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * A credential value must never travel in a connector request body — only
     * the ref that names one. A header known to carry credentials is therefore
     * required to reference one instead of spelling it out.
     */
    private fun requireNoCredentialValues(headers: Map<String, String>) {
        headers.forEach { (name, value) ->
            if (name.trim().lowercase() in CREDENTIAL_HEADERS) {
                require(value.contains(CREDENTIAL_PLACEHOLDER_PREFIX)) {
                    "Header '$name' would send a key in plain text. Save the key once under a " +
                        "credential name, then write the header as " +
                        "\"Bearer {{credential.some_key}}\" so the value never travels with this request."
                }
            }
        }
    }

    private fun mcpRequestTemplate(serverUrl: String, headers: Map<String, String>): String =
        buildJsonObject {
            put("url", serverUrl)
            if (headers.isNotEmpty()) {
                put("headers", JsonObject(headers.mapValues { (_, value) -> JsonPrimitive(value) }))
            }
        }.toString()

    /** The approved manifest, exactly as it will be handed to the model. */
    private fun manifestOf(tools: List<McpConnectorTool>): String =
        JsonArray(
            tools.map { tool ->
                buildJsonObject {
                    put("name", tool.name)
                    put("description", tool.description)
                    tool.inputSchema?.let { schema -> put("inputSchema", schema) }
                }
            }
        ).toString()

    private fun manifestSize(discoveredTools: String): Int =
        runCatching { (parser.parseToJsonElement(discoveredTools) as? JsonArray)?.size ?: 0 }.getOrDefault(0)

    private fun ConnectorOperation.toDraft(specUrl: String, credentialRef: String) = UpsertCustomerToolRequest(
        name = name.trim(),
        description = description.trim(),
        parameters = parameters?.toString().orEmpty(),
        provider = "http",
        request = request?.toString().orEmpty(),
        credentialRef = credentialRef,
        responseTransform = responseTransform?.toString().orEmpty(),
        status = "draft",
        origin = "openapi",
        originRef = specUrl,
        lastDryRunAt = "",
    )

    /** How an operation is named in an all-or-nothing rejection message. */
    private fun ConnectorOperation.label(): String {
        val trimmed = name.trim()
        val where = listOf(method.trim(), path.trim()).filter { it.isNotBlank() }.joinToString(" ")
        return when {
            trimmed.isNotBlank() && where.isNotBlank() -> "$trimmed ($where)"
            trimmed.isNotBlank() -> trimmed
            where.isNotBlank() -> where
            else -> "(unnamed operation)"
        }
    }

    companion object {
        /** The selection cap the UI states, enforced here so it is a rule, not a hint. */
        const val MAX_IMPORTED_OPERATIONS = 20

        /** Headers whose value is a credential often enough to insist on a ref. */
        private val CREDENTIAL_HEADERS = setOf(
            "authorization", "proxy-authorization", "cookie",
            "x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token",
        )
        private const val CREDENTIAL_PLACEHOLDER_PREFIX = "{{credential."

        private val NON_SLUG_CHARS = Regex("[^a-z0-9]+")
        private val NON_NAME_CHARS = Regex("[^a-z0-9]+")

        /** The tool name regex the validator enforces, checked before it does. */
        private val NAME_SHAPE = Regex("^[a-z][a-z0-9_]{2,63}$")

        /**
         * A stable id for a spec connector: a readable slug of the url plus a
         * short digest of the whole url, so two specs differing only past the
         * truncation point stay distinct and the id is the same in every
         * process. The digest guarantees a `-`, which an mcp connector's id —
         * a tool name, `^[a-z][a-z0-9_]{2,63}$` — can never contain, so the two
         * kinds of id cannot collide in the `{id}` path.
         */
        fun slugFor(ref: String): String {
            val trimmed = ref.trim()
            val withoutScheme = trimmed.substringAfter("://", trimmed)
            val readable = NON_SLUG_CHARS.replace(withoutScheme.lowercase(), "-")
                .trim('-')
                .take(48)
                .trim('-')
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(trimmed.toByteArray())
                .take(4)
                .joinToString("") { byte -> "%02x".format(byte) }
            return if (readable.isEmpty()) "spec-$digest" else "$readable-$digest"
        }

        /** The host of a url, for a label a person can read. */
        fun labelFor(ref: String): String {
            val trimmed = ref.trim()
            val afterScheme = trimmed.substringAfter("://", trimmed)
            val authority = afterScheme.substringBefore('/').substringAfter('@')
            val host = authority.substringBefore(':')
            return host.removePrefix("www.")
        }
    }
}

/** Wire payload for the retrieval server's POST /connectors/openapi/preview. */
@Serializable
private data class OpenApiPreviewPayload(
    val customer_id: String,
    val spec_url: String,
    val credential_ref: String,
)

/** Wire payload for the retrieval server's POST /connectors/mcp/discover. */
@Serializable
private data class McpDiscoverPayload(
    val customer_id: String,
    val server_url: String,
    val credential_ref: String,
    val headers: Map<String, String>,
)
