package com.genflowly.service

import com.genflowly.models.api.CustomerTool
import com.genflowly.models.api.DryRunCustomerToolRequest
import com.genflowly.models.api.DryRunCustomerToolResponse
import com.genflowly.models.api.ListCustomerToolsResponse
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
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Per-customer declarative HTTP tools ("bring your own tool").
 *
 * The interesting part of this class is [CustomerToolValidator]: a customer
 * tool is a description of an outbound HTTP call that a *model* gets to fill
 * in, so everything that decides **where** the call goes must be fixed at
 * definition time and everything the model supplies must be declared. The
 * validator is what makes that structural rather than hopeful.
 *
 * Rejection messages are written to be shown to a user verbatim by the UI.
 */
class CustomerToolsService(
    private val customerToolsRepository: CustomerToolsRepository,
    private val json: Json,
    private val httpClient: HttpClient,
    private val retrievalServerUrl: String,
) {

    suspend fun listTools(customerId: String): ListCustomerToolsResponse =
        ListCustomerToolsResponse(
            tools = customerToolsRepository.listCustomerTools(customerId).sortedBy { it.name }
        )

    suspend fun getTool(customerId: String, name: String): CustomerTool? =
        customerToolsRepository.getCustomerTool(customerId, name)

    /**
     * Create or replace a tool. The name is the identity, so saving an existing
     * name overwrites it, bumps [CustomerTool.version] and keeps the original
     * `createdAt`.
     *
     * @throws IllegalArgumentException with a user-facing message when the
     *   definition violates any rule in [CustomerToolValidator] (→ HTTP 400).
     */
    suspend fun saveTool(customerId: String, request: UpsertCustomerToolRequest): CustomerTool {
        CustomerToolValidator.validate(request)

        val existing = customerToolsRepository.getCustomerTool(customerId, request.name)
        val tool = CustomerTool(
            name = request.name,
            description = request.description.trim(),
            parameters = request.parameters,
            provider = request.provider,
            request = request.request,
            credentialRef = request.credentialRef.trim(),
            responseTransform = request.responseTransform,
            discoveredTools = request.discoveredTools,
            status = request.status,
            version = (existing?.version ?: 0) + 1,
            origin = request.origin,
            originRef = request.originRef.trim(),
            lastDryRunAt = request.lastDryRunAt.trim(),
            createdAt = existing?.createdAt,
        )
        customerToolsRepository.saveCustomerTool(customerId, tool)
        logger.info { "Saved tool '${tool.name}' v${tool.version} (${tool.status}) for customer $customerId" }
        return tool
    }

    suspend fun deleteTool(customerId: String, name: String) {
        customerToolsRepository.deleteCustomerTool(customerId, name)
    }

    /**
     * Resolve and actually perform the call once, through the retrieval server,
     * so the editor can show the request that would be sent and the text the
     * model would see.
     *
     * [request] may carry an unsaved draft definition; when it does not, the
     * stored row named by [name] is used. The definition is validated here
     * first, so a broken template fails with this service's user-facing message
     * rather than an opaque runtime error downstream.
     *
     * Credential values are never read, decrypted or forwarded here — the
     * retrieval server resolves `{{credential.*}}` from the customer's stored
     * encrypted blob itself. customerId always comes from the authenticated
     * principal, never from the body.
     *
     * A successful dry run is what lets a tool leave `draft`, so it stamps
     * `lastDryRunAt` on the stored row (when one exists). The stamp does not
     * bump `version` — the definition did not change.
     *
     * @throws IllegalArgumentException when the definition fails validation (→ 400).
     * @throws IllegalStateException when no definition is supplied and none is stored (→ 404).
     */
    suspend fun dryRunTool(
        customerId: String,
        name: String,
        request: DryRunCustomerToolRequest,
    ): DryRunCustomerToolResponse {
        // Validate before anything else happens: a broken draft must not reach
        // the database, the network, or the customer's credential blob.
        val draft = request.tool
        if (draft != null) {
            require(draft.name == name) {
                "The tool definition names '${draft.name}' but the path names '$name'. " +
                    "They must match."
            }
            CustomerToolValidator.validate(draft)
        }

        val stored = customerToolsRepository.getCustomerTool(customerId, name)
        val tool = when {
            draft != null -> CustomerTool(
                name = draft.name,
                description = draft.description.trim(),
                parameters = draft.parameters,
                provider = draft.provider,
                request = draft.request,
                credentialRef = draft.credentialRef.trim(),
                responseTransform = draft.responseTransform,
                discoveredTools = draft.discoveredTools,
                status = draft.status,
                version = stored?.version ?: 0,
                origin = draft.origin,
                originRef = draft.originRef.trim(),
                lastDryRunAt = draft.lastDryRunAt.trim(),
                createdAt = stored?.createdAt,
            )
            // A stored row goes through the same gate — the rules may have
            // tightened since it was written.
            stored != null -> stored.also { CustomerToolValidator.validate(it.toUpsertRequest()) }
            else -> throw IllegalStateException(
                "Tool '$name' not found. Save it first, or send the definition in the dry-run body."
            )
        }

        val result = postDryRun(customerId, tool, request.args)

        if (result.ok && stored != null) {
            val stampedAt = Instant.now().toString()
            customerToolsRepository.saveCustomerTool(
                customerId,
                stored.copy(lastDryRunAt = stampedAt)
            )
            logger.info { "Dry run of '$name' succeeded for customer $customerId; stamped lastDryRunAt" }
        }
        return result
    }

    /**
     * The shared [Json] omits fields that equal their default, which would drop
     * `provider`, `status`, `version` and friends from the wire record whenever
     * they happen to hold their default value. The tool runner reads the whole
     * record, so encode every field.
     */
    private val wireJson = Json(json) { encodeDefaults = true }

    private suspend fun postDryRun(
        customerId: String,
        tool: CustomerTool,
        args: Map<String, kotlinx.serialization.json.JsonElement>,
    ): DryRunCustomerToolResponse {
        val payload = wireJson.encodeToString(
            ToolDryRunPayload(customer_id = customerId, tool = tool, args = args)
        )
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/tools/dry-run") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            val body = response.bodyAsText()
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server /tools/dry-run returned ${response.status}: $body" }
                return DryRunCustomerToolResponse(
                    ok = false,
                    error = "The tool runner could not complete the test call (${response.status})."
                )
            }
            wireJson.decodeFromString<DryRunCustomerToolResponse>(body)
        } catch (e: Exception) {
            logger.warn { "Dry run of '${tool.name}' failed for customer $customerId: ${e.message}" }
            DryRunCustomerToolResponse(
                ok = false,
                error = "The tool runner is unreachable right now. Please try again."
            )
        }
    }
}

/** Wire payload for the retrieval server's POST /tools/dry-run. */
@Serializable
private data class ToolDryRunPayload(
    val customer_id: String,
    val tool: CustomerTool,
    val args: Map<String, kotlinx.serialization.json.JsonElement>,
)

/** Round-trips a stored row back through the same validation a save runs. */
private fun CustomerTool.toUpsertRequest() = UpsertCustomerToolRequest(
    name = name,
    description = description,
    parameters = parameters,
    provider = provider,
    request = request,
    credentialRef = credentialRef,
    responseTransform = responseTransform,
    discoveredTools = discoveredTools,
    status = status,
    origin = origin,
    originRef = originRef,
    lastDryRunAt = lastDryRunAt,
)

/**
 * Stateless validator for a customer tool definition. Every check throws
 * [IllegalArgumentException] with a message meant to be rendered verbatim in
 * the tool editor; the activity layer maps that to HTTP 400.
 *
 * Rules enforced:
 *  1. `name` matches `^[a-z][a-z0-9_]{2,63}$`.
 *  2. `name` does not collide with a built-in tool (web_search, generate_pdf).
 *  3. `description` is 10..1024 characters.
 *  4. `provider` is http|mcp; `status` is draft|active|disabled; `origin` is
 *     manual|openapi. Rules 5-9 below are the **http** shape; an mcp record is
 *     a server rather than a call, so it is validated by [validateMcpRecord]
 *     instead (https server url with no placeholders, plus an approved
 *     discoveredTools manifest).
 *  5. `parameters` is a restricted JSON Schema object: root
 *     {type:"object", properties, required}, at most 20 properties, property
 *     types limited to string/number/integer/boolean, only `description` and
 *     `enum` beside `type`; no nesting, no `$ref`, no arrays, no
 *     `additionalProperties` object.
 *  6. `request.method` is one of GET/POST/PUT/PATCH/DELETE.
 *  7. `request.url` is https and its **scheme and host are literal** — a
 *     placeholder there is rejected. That is what makes it structurally
 *     impossible for a prompt-injected argument to redirect the call.
 *  8. Every placeholder is spelled `{{args.<key>}}` or `{{credential.<key>}}`,
 *     and every `args` key is declared in `parameters.properties`.
 *  9. `responseTransform.mode` is text|json|json_path (`path` required for
 *     json_path), `maxChars` in 1..32000.
 * 10. `status: "active"` requires a non-empty `lastDryRunAt`.
 */
object CustomerToolValidator {

    /** Names reserved by the runtime's built-in tools. */
    val BUILTIN_TOOL_NAMES = setOf("web_search", "generate_pdf")

    val ALLOWED_METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE")
    val ALLOWED_PROVIDERS = setOf("http", "mcp")
    val ALLOWED_STATUSES = setOf("draft", "active", "disabled")
    val ALLOWED_ORIGINS = setOf("manual", "openapi")
    val ALLOWED_PROPERTY_TYPES = setOf("string", "number", "integer", "boolean")
    val ALLOWED_TRANSFORM_MODES = setOf("text", "json", "json_path")
    val ALLOWED_BODY_TYPES = setOf("json", "form")

    const val MAX_PROPERTIES = 20
    const val MAX_RESPONSE_CHARS = 32000
    const val MIN_DESCRIPTION_LENGTH = 10
    const val MAX_DESCRIPTION_LENGTH = 1024

    private val NAME_REGEX = Regex("^[a-z][a-z0-9_]{2,63}$")
    private val PROPERTY_NAME_REGEX = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

    /** Any `{{ ... }}` occurrence, so a misspelled namespace is caught too. */
    private val PLACEHOLDER_REGEX = Regex("""\{\{([^}]*)}}""")
    private val PLACEHOLDER_BODY_REGEX = Regex("""^(args|credential)\.([A-Za-z_][A-Za-z0-9_]*)$""")

    private val jsonParser = Json { ignoreUnknownKeys = true }

    fun validate(request: UpsertCustomerToolRequest) {
        validateName(request.name)
        validateDescription(request.description)
        validateEnums(request.provider, request.status, request.origin)
        validateDryRun(request.status, request.lastDryRunAt)

        // An mcp record describes a SERVER, not a call: there is no method,
        // body or response transform to check, and each discovered tool brings
        // its own argument schema.
        if (request.provider == "mcp") {
            validateMcpRecord(request)
            return
        }

        val declaredArgs = validateParameters(request.parameters)
        validateRequest(request.request, declaredArgs)
        validateResponseTransform(request.responseTransform)
    }

    // ── mcp — a server, and the manifest we pinned from it ────────────────────

    /**
     * An mcp record names one server and carries the tool manifest captured when
     * the customer connected it.
     *
     * The manifest is required because binding never calls the server: the
     * runtime reads what was approved. A record with no manifest would silently
     * contribute no tools, so it is rejected here where the message can say why.
     */
    private fun validateMcpRecord(request: UpsertCustomerToolRequest) {
        val root = parseObject(request.request, "request")

        val unknown = root.keys - setOf("url", "headers", "timeoutSeconds")
        require(unknown.isEmpty()) {
            "An MCP tool's request may only contain url, headers and timeoutSeconds. " +
                "Unexpected: ${unknown.sorted().joinToString(", ")}."
        }

        val url = (root["url"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        require(url.isNotBlank()) { "An MCP tool needs the server's url." }
        require(url.startsWith("https://")) {
            "The MCP server url must start with https:// — a plaintext connection would expose " +
                "the credential it carries."
        }
        require(!url.contains("{{")) {
            "The MCP server url cannot contain a placeholder. The server is fixed when the tool " +
                "is connected, so no value supplied at call time can redirect it."
        }

        // Headers may carry {{credential.*}} but never {{args.*}}: they are sent
        // once per connection, before any tool call has arguments.
        (root["headers"] as? JsonObject)?.forEach { (headerName, value) ->
            val text = (value as? JsonPrimitive)?.contentOrNull.orEmpty()
            PLACEHOLDER_REGEX.findAll(text).forEach { match ->
                val body = match.groupValues[1].trim()
                require(PLACEHOLDER_BODY_REGEX.matches(body)) {
                    "Header '$headerName' contains '{{$body}}', which is not a valid placeholder. " +
                        "Use {{credential.some_key}}."
                }
                require(body.startsWith("credential.")) {
                    "Header '$headerName' uses '{{$body}}'. An MCP server's headers are sent when " +
                        "the connection opens, before any arguments exist, so only " +
                        "{{credential.*}} may appear there."
                }
            }
        }

        val manifest = request.discoveredTools.trim()
        require(manifest.isNotEmpty()) {
            "This MCP server has no approved tool list yet. Connect it and approve the tools it " +
                "offers before saving, so the agent binds a list you have seen."
        }
        val entries = try {
            jsonParser.parseToJsonElement(manifest) as? JsonArray
        } catch (e: Exception) {
            throw IllegalArgumentException("The MCP tool list is not valid JSON.", e)
        }
        requireNotNull(entries) { "The MCP tool list must be a JSON array." }
        require(entries.isNotEmpty()) {
            "The MCP tool list is empty, so this server would contribute nothing."
        }
        entries.forEachIndexed { index, entry ->
            val obj = entry as? JsonObject
            requireNotNull(obj) { "Entry ${index + 1} in the MCP tool list is not an object." }
            val toolName = (obj["name"] as? JsonPrimitive)?.contentOrNull.orEmpty()
            require(toolName.isNotBlank()) {
                "Entry ${index + 1} in the MCP tool list has no name."
            }
        }
    }

    // ── Identity ──────────────────────────────────────────────────────────────

    private fun validateName(name: String) {
        require(NAME_REGEX.matches(name)) {
            "Tool name '$name' is not valid. Use 3 to 64 characters: start with a lowercase letter, " +
                "then lowercase letters, digits or underscores (for example: create_linear_issue)."
        }
        require(name !in BUILTIN_TOOL_NAMES) {
            "Tool name '$name' is reserved by a built-in tool. Built-in names are: " +
                "${BUILTIN_TOOL_NAMES.sorted().joinToString(", ")}. Please choose a different name."
        }
    }

    private fun validateDescription(description: String) {
        val trimmed = description.trim()
        require(trimmed.length >= MIN_DESCRIPTION_LENGTH) {
            "Tool description is too short (${trimmed.length} characters). The model only sees this " +
                "description, so it must be at least $MIN_DESCRIPTION_LENGTH characters explaining when to use the tool."
        }
        require(trimmed.length <= MAX_DESCRIPTION_LENGTH) {
            "Tool description is too long (${trimmed.length} characters). The maximum is " +
                "$MAX_DESCRIPTION_LENGTH characters."
        }
    }

    private fun validateEnums(provider: String, status: String, origin: String) {
        require(provider in ALLOWED_PROVIDERS) {
            "Tool provider '$provider' is not supported. Supported providers: " +
                "${ALLOWED_PROVIDERS.sorted().joinToString(", ")}."
        }
        require(status in ALLOWED_STATUSES) {
            "Tool status '$status' is not valid. Use one of: ${ALLOWED_STATUSES.sorted().joinToString(", ")}."
        }
        require(origin in ALLOWED_ORIGINS) {
            "Tool origin '$origin' is not valid. Use one of: ${ALLOWED_ORIGINS.sorted().joinToString(", ")}."
        }
    }

    private fun validateDryRun(status: String, lastDryRunAt: String) {
        require(!(status == "active" && lastDryRunAt.isBlank())) {
            "This tool cannot be activated yet: run a test call first. A tool may only leave draft " +
                "once it has completed at least one successful dry run."
        }
    }

    // ── parameters — restricted JSON Schema ───────────────────────────────────

    /** @return the declared property names, used to check `{{args.*}}` placeholders. */
    private fun validateParameters(parameters: String): Set<String> {
        val root = parseObject(parameters, "Tool parameters")

        val unknownRootKeys = root.keys - setOf("type", "properties", "required", "additionalProperties")
        require(unknownRootKeys.isEmpty()) {
            "Tool parameters contain unsupported field(s): ${unknownRootKeys.sorted().joinToString(", ")}. " +
                "Only 'type', 'properties' and 'required' are allowed at the top level."
        }

        val type = (root["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        require(type == "object") {
            "Tool parameters must have \"type\": \"object\" at the top level" +
                (if (type == null) "." else ", not \"$type\".")
        }

        root["additionalProperties"]?.let { additional ->
            require(additional is JsonPrimitive && !additional.isString && additional.content.toBooleanStrictOrNull() != null) {
                "Tool parameters may not use an 'additionalProperties' schema object. " +
                    "Every argument the model may send must be declared in 'properties'."
            }
        }

        val properties = root["properties"] as? JsonObject
        requireNotNull(properties) {
            "Tool parameters must contain a 'properties' object listing the arguments the model may send " +
                "(use an empty object {} for a tool that takes no arguments)."
        }
        require(properties.size <= MAX_PROPERTIES) {
            "Tool parameters declare ${properties.size} properties; the maximum is $MAX_PROPERTIES. " +
                "Consider splitting this into more than one tool."
        }

        properties.forEach { (propertyName, schema) -> validateProperty(propertyName, schema) }

        root["required"]?.let { required ->
            require(required is JsonArray) {
                "Tool parameters 'required' must be an array of property names."
            }
            required.forEachIndexed { index, element ->
                val requiredName = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
                requireNotNull(requiredName) {
                    "Tool parameters 'required' entry #${index + 1} must be a property name string."
                }
                require(properties.containsKey(requiredName)) {
                    "Tool parameters mark '$requiredName' as required, but no such property is declared. " +
                        "Declared properties: ${properties.keys.sorted().joinToString(", ").ifEmpty { "(none)" }}."
                }
            }
        }

        return properties.keys
    }

    private fun validateProperty(propertyName: String, schema: JsonElement) {
        require(PROPERTY_NAME_REGEX.matches(propertyName)) {
            "Parameter name '$propertyName' is not valid. Use letters, digits and underscores, " +
                "starting with a letter or underscore."
        }
        require(schema is JsonObject) {
            "Parameter '$propertyName' must be described by an object such as " +
                "{\"type\": \"string\", \"description\": \"...\"}."
        }

        val unknownKeys = schema.keys - setOf("type", "description", "enum")
        require(unknownKeys.isEmpty()) {
            "Parameter '$propertyName' uses unsupported field(s): ${unknownKeys.sorted().joinToString(", ")}. " +
                "Only 'type', 'description' and 'enum' are allowed — nested objects, arrays and \$ref are not supported."
        }

        val type = (schema["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        requireNotNull(type) {
            "Parameter '$propertyName' is missing a 'type'. Use one of: " +
                "${ALLOWED_PROPERTY_TYPES.sorted().joinToString(", ")}."
        }
        require(type in ALLOWED_PROPERTY_TYPES) {
            "Parameter '$propertyName' has unsupported type '$type'. Use one of: " +
                "${ALLOWED_PROPERTY_TYPES.sorted().joinToString(", ")}."
        }

        schema["description"]?.let { description ->
            require(description is JsonPrimitive && description.isString) {
                "Parameter '$propertyName' has a non-text 'description'."
            }
        }

        schema["enum"]?.let { enum ->
            require(enum is JsonArray && enum.isNotEmpty()) {
                "Parameter '$propertyName' has an 'enum' that is not a non-empty array of allowed values."
            }
            enum.forEach { value ->
                require(value is JsonPrimitive && value !is JsonNull) {
                    "Parameter '$propertyName' has an 'enum' containing a non-scalar value. " +
                        "Enum values must be plain strings, numbers or booleans."
                }
            }
        }
    }

    // ── request — the call template ───────────────────────────────────────────

    private fun validateRequest(requestJson: String, declaredArgs: Set<String>) {
        val request = parseObject(requestJson, "Tool request")

        val unknownKeys = request.keys - setOf("method", "url", "headers", "query", "body", "bodyType")
        require(unknownKeys.isEmpty()) {
            "Tool request contains unsupported field(s): ${unknownKeys.sorted().joinToString(", ")}. " +
                "Allowed fields: method, url, headers, query, body, bodyType."
        }

        // method
        val method = (request["method"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        requireNotNull(method) { "Tool request is missing a 'method'." }
        require(method in ALLOWED_METHODS) {
            "HTTP method '$method' is not allowed. Use one of: ${ALLOWED_METHODS.sorted().joinToString(", ")}."
        }

        // url — scheme and host are pinned at definition time
        val url = (request["url"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        requireNotNull(url) { "Tool request is missing a 'url'." }
        validateUrl(url)

        // Collect every templated string and check the placeholders in it.
        val templated = mutableListOf<String>()
        templated += url
        templated += stringMapValues(request["headers"], "headers")
        templated += stringMapValues(request["query"], "query")

        val body = request["body"]
        if (body != null && body !is JsonNull) {
            require(body is JsonObject) {
                "Tool request 'body' must be an object of field names to values, or null for no body."
            }
            collectStrings(body, templated)

            val bodyType = (request["bodyType"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "json"
            require(bodyType in ALLOWED_BODY_TYPES) {
                "Tool request 'bodyType' must be one of: ${ALLOWED_BODY_TYPES.sorted().joinToString(", ")}."
            }
        }

        templated.forEach { validatePlaceholders(it, declaredArgs) }
    }

    private fun validateUrl(url: String) {
        // The authority is everything before the first '/' after "scheme://".
        val schemeSeparator = url.indexOf("://")
        require(schemeSeparator > 0) {
            "Tool request url '$url' is not an absolute URL. It must start with https://"
        }
        require(url.startsWith("https://", ignoreCase = true)) {
            "Tool request url '$url' must use https. Plain http is not allowed for customer tools."
        }

        val afterScheme = schemeSeparator + 3
        val pathStart = url.indexOf('/', afterScheme).let { if (it == -1) url.length else it }
        val authority = url.substring(0, pathStart)
        val host = url.substring(afterScheme, pathStart)

        require(!authority.contains("{{")) {
            "Tool request url has a placeholder in its scheme or host ('$authority'). " +
                "The host is fixed when the tool is defined — only the path, query values, header " +
                "values and body values may be templated."
        }
        require(host.isNotBlank()) {
            "Tool request url '$url' has no host."
        }
    }

    private fun validatePlaceholders(value: String, declaredArgs: Set<String>) {
        PLACEHOLDER_REGEX.findAll(value).forEach { match ->
            val inner = match.groupValues[1].trim()
            val parsed = PLACEHOLDER_BODY_REGEX.find(inner)
            requireNotNull(parsed) {
                "Placeholder '${match.value}' is not valid. Placeholders are spelled " +
                    "{{args.some_parameter}} or {{credential.some_key}}."
            }
            val namespace = parsed.groupValues[1]
            val key = parsed.groupValues[2]
            if (namespace == "args") {
                require(key in declaredArgs) {
                    "Placeholder '{{args.$key}}' refers to a parameter that is not declared. " +
                        "Declared parameters: ${declaredArgs.sorted().joinToString(", ").ifEmpty { "(none)" }}."
                }
            }
        }
    }

    // ── responseTransform ─────────────────────────────────────────────────────

    private fun validateResponseTransform(responseTransformJson: String) {
        val transform = parseObject(responseTransformJson, "Tool response transform")

        val unknownKeys = transform.keys - setOf("mode", "path", "maxChars")
        require(unknownKeys.isEmpty()) {
            "Tool response transform contains unsupported field(s): " +
                "${unknownKeys.sorted().joinToString(", ")}. Allowed fields: mode, path, maxChars."
        }

        val mode = (transform["mode"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        requireNotNull(mode) { "Tool response transform is missing a 'mode'." }
        require(mode in ALLOWED_TRANSFORM_MODES) {
            "Tool response transform mode '$mode' is not valid. Use one of: " +
                "${ALLOWED_TRANSFORM_MODES.sorted().joinToString(", ")}."
        }

        if (mode == "json_path") {
            val path = (transform["path"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            require(!path.isNullOrBlank()) {
                "Tool response transform mode 'json_path' needs a dotted 'path', " +
                    "for example data.issueCreate.issue.identifier."
            }
        }

        transform["maxChars"]?.let { maxChars ->
            val value = (maxChars as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()
            requireNotNull(value) { "Tool response transform 'maxChars' must be a whole number." }
            require(value in 1..MAX_RESPONSE_CHARS) {
                "Tool response transform 'maxChars' is $value; it must be between 1 and $MAX_RESPONSE_CHARS."
            }
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private fun parseObject(raw: String, label: String): JsonObject {
        val element = try {
            jsonParser.parseToJsonElement(raw)
        } catch (e: Exception) {
            throw IllegalArgumentException("$label is not valid JSON: ${e.message}")
        }
        return element as? JsonObject
            ?: throw IllegalArgumentException("$label must be a JSON object.")
    }

    /** The string values of an optional `{name: "value"}` map field. */
    private fun stringMapValues(element: JsonElement?, label: String): List<String> {
        if (element == null || element is JsonNull) return emptyList()
        require(element is JsonObject) {
            "Tool request '$label' must be an object mapping names to text values."
        }
        return element.map { (key, value) ->
            require(value is JsonPrimitive && value.isString) {
                "Tool request '$label.$key' must be a text value — templates such as " +
                    "\"{{args.limit}}\" are strings."
            }
            value.content
        }
    }

    /** Collects every string leaf of a body object so its placeholders are checked. */
    private fun collectStrings(element: JsonElement, into: MutableList<String>) {
        when (element) {
            is JsonObject -> element.values.forEach { collectStrings(it, into) }
            is JsonArray -> element.forEach { collectStrings(it, into) }
            is JsonPrimitive -> if (element.isString) into += element.content
            else -> Unit
        }
    }
}
