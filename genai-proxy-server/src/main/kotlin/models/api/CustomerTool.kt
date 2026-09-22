package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * A customer-defined declarative HTTP tool ("bring your own tool").
 *
 * The row carries no secrets: [credentialRef] names a sort key in the
 * customer's CustomerToolCredentials space, whose values stay KMS-encrypted
 * there and are resolved only at execution time.
 *
 * [parameters], [request] and [responseTransform] are transported as JSON
 * *strings* rather than typed objects — the same choice the graph editor makes
 * for node config. It keeps the stored DynamoDB attribute byte-identical to
 * what the client sent and lets the shape evolve (http today, mcp later)
 * without a serializer change on every field.
 */
@Serializable
data class CustomerTool(
    /** Model-facing tool name; per-customer unique (it is the sort key). */
    val name: String,
    /** Model-facing description, 10..1024 chars. */
    val description: String,
    /** JSON string: a restricted, non-nested JSON Schema object. */
    val parameters: String,
    /** "http" (one record, one call) or "mcp" (one record, one server). */
    val provider: String = "http",
    /** JSON string: the call template (method/url/headers/query/body/bodyType). */
    val request: String,
    /** CustomerToolCredentials sort key, or "" when the tool needs no auth. */
    val credentialRef: String = "",
    /** JSON string: {mode, path, maxChars}. */
    val responseTransform: String,
    /** "draft" | "active" | "disabled". Only "active" is ever bound to an agent. */
    val status: String = "draft",
    /** Bumped on every save. */
    val version: Int = 1,
    /** "manual" | "openapi". */
    val origin: String = "manual",
    /** Spec/docs URL that produced this tool, for audit. */
    val originRef: String = "",
    /** ISO-8601; must be non-empty before the tool may leave "draft". */
    val lastDryRunAt: String = "",
    /**
     * mcp only. JSON string: the server's tool manifest, captured and approved
     * when the customer connected it — `[{name, description, inputSchema}, ...]`.
     *
     * Pinned rather than discovered at bind time for two reasons. Discovery on
     * every request would put a network round trip on the critical path, and,
     * more importantly, a tool's description is text placed directly into the
     * model's context: a server free to rewrite it between turns could steer the
     * agent through a channel the customer never sees. A changed manifest is a
     * change someone re-approves.
     */
    val discoveredTools: String = "",
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

/**
 * Create-or-replace body for `POST /api/v1/tools`. [name] is the identity, so a
 * POST with an existing name overwrites that tool and bumps its version.
 */
@Serializable
data class UpsertCustomerToolRequest(
    val name: String,
    val description: String,
    /** http only: the restricted JSON Schema for the model's arguments. An mcp
     *  record leaves this empty — each discovered tool carries its own schema. */
    val parameters: String = "",
    /** "http" (one record, one call) or "mcp" (one record, one server). */
    val provider: String = "http",
    val request: String,
    val credentialRef: String = "",
    /** http only: {mode, path, maxChars}. Unused by mcp, whose results are
     *  already content blocks. */
    val responseTransform: String = "",
    /** mcp only: the server's approved tool manifest. See [CustomerTool.discoveredTools]. */
    val discoveredTools: String = "",
    val status: String = "draft",
    val origin: String = "manual",
    val originRef: String = "",
    val lastDryRunAt: String = "",
)

@Serializable
data class ListCustomerToolsResponse(
    val tools: List<CustomerTool>
)

// ── Dry run ───────────────────────────────────────────────────────────────────

/**
 * Body of `POST /api/v1/tools/{name}/dry-run`.
 *
 * [tool] lets an *unsaved* draft be tested straight from the editor; when it is
 * omitted the stored row named by the path is used instead. There is
 * deliberately no customerId here — it always comes from the authenticated
 * principal.
 */
@Serializable
data class DryRunCustomerToolRequest(
    /** The definition to test; null means "use the stored tool with this name". */
    val tool: UpsertCustomerToolRequest? = null,
    /** Sample arguments, as the model would supply them. */
    val args: Map<String, kotlinx.serialization.json.JsonElement> = emptyMap(),
)

/** The request the retrieval server actually resolved and sent. */
@Serializable
data class DryRunResolvedRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val query: Map<String, String> = emptyMap(),
    val body: kotlinx.serialization.json.JsonElement? = null,
)

/** What the upstream API answered. */
@Serializable
data class DryRunHttpResponse(
    val status_code: Int,
    val body: String,
    val truncated: Boolean = false,
)

/**
 * The retrieval server's dry-run result, relayed to the client unchanged —
 * field names are the retrieval server's, so the editor and the runtime read
 * exactly the same payload.
 */
@Serializable
data class DryRunCustomerToolResponse(
    val ok: Boolean,
    val request: DryRunResolvedRequest? = null,
    val response: DryRunHttpResponse? = null,
    /** The text the model would receive, after responseTransform. */
    val model_sees: String? = null,
    val error: String? = null,
)
