package com.genflowly.models.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * A **connector** is one thing the customer connects that yields many tools.
 *
 * There is deliberately no Connectors table. A connector is a *view* over rows
 * that already exist in `CustomerTools`:
 *
 *  - an **mcp** connector is a single row with `provider == "mcp"`, whose
 *    [CustomerTool.discoveredTools] manifest is the list of tools it yields;
 *  - an **openapi** connector is the set of rows sharing an
 *    [CustomerTool.originRef] — the spec url they were generated from.
 *
 * Deriving instead of storing means the two can never disagree: deleting the
 * last tool of a spec deletes the connector, and nothing can leave a connector
 * row pointing at tools that are gone.
 */
@Serializable
data class Connector(
    /**
     * For mcp, the tool row's `name` (its sort key). For openapi, a stable slug
     * of [ref], so the same spec url always yields the same id, in this process
     * and the next one.
     */
    val id: String,
    /** "openapi" | "mcp". */
    val kind: String,
    /** Human-facing label — the host of [ref] when it parses, else [ref]. */
    val label: String,
    /** The spec url (openapi) or the server url (mcp) the customer supplied. */
    val ref: String,
    /** How many tools this connector yields: rows for openapi, manifest entries for mcp. */
    val toolCount: Int,
    /** CustomerToolCredentials sort key; never a credential value. */
    val credentialRef: String = "",
    /** ISO-8601 creation time of the connector's oldest row. */
    val connectedAt: String = "",
)

@Serializable
data class ListConnectorsResponse(
    val connectors: List<Connector>
)

/**
 * `DELETE /api/v1/connectors/{id}` — how many tools that removed.
 *
 * [removed] counts the tools the customer was shown, so the number in the
 * confirmation dialog is the number in the result. [rowsDeleted] counts the
 * `CustomerTools` rows behind them; the two differ only for an MCP server,
 * which is one row yielding a whole manifest.
 */
@Serializable
data class DeleteConnectorResponse(
    val id: String,
    val removed: Int,
    val rowsDeleted: Int,
)

// ── OpenAPI spec connectors ───────────────────────────────────────────────────

/**
 * Body of `POST /api/v1/connectors/openapi/preview`.
 *
 * There is no customerId here — it always comes from the authenticated
 * principal — and no credential value: [credentialRef] only names where the
 * generated drafts should look for their key.
 */
@Serializable
data class PreviewOpenApiConnectorRequest(
    /** The OpenAPI/Swagger document url. User-supplied, so it is fetched only
     *  by the retrieval server's SSRF-hardened client, never by the proxy. */
    val specUrl: String,
    val credentialRef: String = "",
)

/**
 * One operation the spec offers: a ready-to-save tool record minus
 * `credentialRef`, which the import step fills in.
 *
 * [parameters], [request] and [responseTransform] arrive as JSON *objects* from
 * the retrieval server and are stored on the row as JSON strings; the service
 * does that re-encoding so the browser never has to.
 */
@Serializable
data class ConnectorOperation(
    val name: String,
    val description: String = "",
    val method: String = "",
    val path: String = "",
    val parameters: JsonElement? = null,
    val request: JsonElement? = null,
    val responseTransform: JsonElement? = null,
    /** Non-fatal notes about this operation, shown next to its checkbox. */
    val warnings: List<String> = emptyList(),
)

/** An operation the parser could not turn into a tool, and why. */
@Serializable
data class ConnectorSkippedOperation(
    val operationId: String = "",
    val reason: String = "",
)

/**
 * The retrieval server's preview result, relayed unchanged — including its
 * `server_url` spelling, the same choice [DryRunCustomerToolResponse] makes, so
 * the editor and the runtime read one payload rather than two dialects.
 */
@Serializable
data class PreviewOpenApiConnectorResponse(
    val ok: Boolean,
    val title: String = "",
    val server_url: String = "",
    val operations: List<ConnectorOperation> = emptyList(),
    val skipped: List<ConnectorSkippedOperation> = emptyList(),
    val error: String? = null,
)

/**
 * Body of `POST /api/v1/connectors/openapi/import`: the operations the customer
 * ticked, sent back exactly as preview returned them.
 *
 * Import is all-or-nothing. Every operation is put through
 * `CustomerToolValidator` first and, if any fails, none is written — a
 * half-imported connector would show a tool count that does not match what the
 * customer approved.
 */
@Serializable
data class ImportOpenApiConnectorRequest(
    val specUrl: String,
    val credentialRef: String = "",
    val operations: List<ConnectorOperation> = emptyList(),
)

/** The saved drafts plus the connector they now form. */
@Serializable
data class ImportConnectorResponse(
    val connector: Connector,
    val tools: List<CustomerTool>,
)

// ── MCP server connectors ─────────────────────────────────────────────────────

/**
 * Body of `POST /api/v1/connectors/mcp/discover`.
 *
 * [headers] may template `{{credential.*}}` and nothing else: they are sent when
 * the connection opens, before any tool call has arguments. A literal key in an
 * authorization header is rejected — it belongs in the credential store that
 * [credentialRef] names.
 */
@Serializable
data class DiscoverMcpConnectorRequest(
    val serverUrl: String,
    val credentialRef: String = "",
    val headers: Map<String, String> = emptyMap(),
)

/** One tool an MCP server offers. This is exactly what gets pinned. */
@Serializable
data class McpConnectorTool(
    val name: String,
    val description: String = "",
    val inputSchema: JsonElement? = null,
)

/** The retrieval server's discovery result, relayed unchanged. */
@Serializable
data class DiscoverMcpConnectorResponse(
    val ok: Boolean,
    val server_name: String = "",
    val tool_count: Int = 0,
    val tools: List<McpConnectorTool> = emptyList(),
    val error: String? = null,
)

/**
 * Body of `POST /api/v1/connectors/mcp/connect`: the manifest the customer just
 * approved, plus the name the resulting row will carry.
 *
 * [tools] is sent back rather than re-discovered on purpose. The point of the
 * two-step flow is that what the agent is later told is what a human read; a
 * server that changed its answer between the two calls must be re-approved, not
 * silently accepted.
 */
@Serializable
data class ConnectMcpConnectorRequest(
    val serverUrl: String,
    /** What the customer calls this connection, in their own words. */
    val label: String = "",
    /**
     * Model-facing name for the row, `^[a-z][a-z0-9_]{2,63}$`. Optional: the UI
     * asks for a [label] in plain words, and the service derives a tool name
     * from it when none is sent.
     */
    val name: String = "",
    /** Model-facing description. Derived from [label] and the host when empty. */
    val description: String = "",
    val credentialRef: String = "",
    val headers: Map<String, String> = emptyMap(),
    /** The approved manifest. Empty is rejected: it would bind nothing. */
    val tools: List<McpConnectorTool> = emptyList(),
)

/**
 * `POST /api/v1/connectors/mcp/connect` — the connector and the one row behind
 * it. An MCP server is a single row however many tools it offers, so this
 * deliberately does not return a list.
 */
@Serializable
data class ConnectMcpConnectorResponse(
    val connector: Connector,
    val tool: CustomerTool,
)
