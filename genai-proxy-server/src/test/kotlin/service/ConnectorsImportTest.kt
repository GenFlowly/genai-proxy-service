package com.genflowly.service

import com.genflowly.models.api.ConnectMcpConnectorRequest
import com.genflowly.models.api.ConnectorOperation
import com.genflowly.models.api.DiscoverMcpConnectorRequest
import com.genflowly.models.api.ImportOpenApiConnectorRequest
import com.genflowly.models.api.McpConnectorTool
import com.genflowly.models.api.PreviewOpenApiConnectorRequest
import com.genflowly.repository.CustomerToolsRepository
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The two-step connector flows.
 *
 * What is pinned here: the first step writes *nothing* (it exists so a human
 * can read what they are about to hand an agent), the second step is
 * all-or-nothing, and no credential value is ever allowed into a request body.
 */
class ConnectorsImportTest {

    private val repository = mockk<CustomerToolsRepository>(relaxed = true)
    private val json = Json { ignoreUnknownKeys = true }

    private val requestPaths = mutableListOf<String>()
    private val requestBodies = mutableListOf<String>()

    private fun serviceReturning(
        responseBody: String,
        status: HttpStatusCode = HttpStatusCode.OK,
    ): ConnectorsService {
        val engine = MockEngine { request ->
            requestPaths += request.url.encodedPath
            requestBodies += String((request.body as io.ktor.http.content.OutgoingContent.ByteArrayContent).bytes())
            respond(
                content = responseBody,
                status = status,
                headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
            )
        }
        return ConnectorsService(
            customerToolsRepository = repository,
            json = json,
            httpClient = HttpClient(engine),
            retrievalServerUrl = "http://retrieval:8000",
        )
    }

    private fun element(raw: String): JsonElement = json.parseToJsonElement(raw)

    private val specUrl = "https://api.example.com/openapi.json"

    private fun operation(
        name: String = "list_issues",
        description: String = "List the issues in the customer's tracker.",
        method: String = "GET",
        path: String = "/v1/issues",
        parameters: String = """{"type":"object","properties":{"limit":{"type":"integer"}},"required":[]}""",
        requestTemplate: String = """{"method":"GET","url":"https://api.example.com/v1/issues",
            "headers":{"Authorization":"Bearer {{credential.api_key}}"},
            "query":{"limit":"{{args.limit}}"},"body":null}""",
        responseTransform: String = """{"mode":"json","maxChars":8000}""",
    ) = ConnectorOperation(
        name = name,
        description = description,
        method = method,
        path = path,
        parameters = element(parameters),
        request = element(requestTemplate),
        responseTransform = element(responseTransform),
    )

    private val previewResponse = """
        {"ok":true,
         "title":"Example API",
         "server_url":"https://api.example.com",
         "operations":[
           {"name":"list_issues","description":"List issues.","method":"GET","path":"/v1/issues",
            "parameters":{"type":"object","properties":{}},
            "request":{"method":"GET","url":"https://api.example.com/v1/issues"},
            "responseTransform":{"mode":"json"},"warnings":["No pagination declared."]}],
         "skipped":[{"operationId":"uploadFile","reason":"multipart bodies are not supported"}],
         "error":null}
    """.trimIndent()

    private val discoverResponse = """
        {"ok":true,"server_name":"Notion","tool_count":2,
         "tools":[{"name":"search","description":"Search pages.","inputSchema":{"type":"object"}},
                  {"name":"create_page","description":"Create a page.","inputSchema":{"type":"object"}}],
         "error":null}
    """.trimIndent()

    // ── Step one writes nothing ───────────────────────────────────────────────

    @Test
    fun `preview forwards to the retrieval server and writes nothing`() = runTest {
        val service = serviceReturning(previewResponse)

        val result = service.previewOpenApi(
            "cust-1",
            PreviewOpenApiConnectorRequest(specUrl = specUrl, credentialRef = "EXAMPLE"),
        )

        assertTrue(result.ok)
        assertEquals("Example API", result.title)
        assertEquals("https://api.example.com", result.server_url)
        assertEquals(1, result.operations.size)
        assertEquals(listOf("No pagination declared."), result.operations.single().warnings)
        assertEquals("uploadFile", result.skipped.single().operationId)

        assertEquals(listOf("/connectors/openapi/preview"), requestPaths)
        val forwarded = requestBodies.single()
        assertTrue(forwarded.contains(""""customer_id":"cust-1""""), "customerId comes from the caller")
        assertTrue(forwarded.contains(specUrl))
        assertTrue(forwarded.contains(""""credential_ref":"EXAMPLE""""))

        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
        coVerify(exactly = 0) { repository.deleteCustomerTool(any(), any()) }
    }

    @Test
    fun `discover forwards to the retrieval server and writes nothing`() = runTest {
        val service = serviceReturning(discoverResponse)

        val result = service.discoverMcp(
            "cust-1",
            DiscoverMcpConnectorRequest(
                serverUrl = "https://mcp.notion.com/mcp",
                credentialRef = "NOTION",
                headers = mapOf("Authorization" to "Bearer {{credential.token}}"),
            ),
        )

        assertTrue(result.ok)
        assertEquals("Notion", result.server_name)
        assertEquals(2, result.tool_count)
        assertEquals(listOf("search", "create_page"), result.tools.map { it.name })

        assertEquals(listOf("/connectors/mcp/discover"), requestPaths)
        val forwarded = requestBodies.single()
        assertTrue(forwarded.contains(""""customer_id":"cust-1""""))
        assertTrue(forwarded.contains(""""server_url":"https://mcp.notion.com/mcp""""))
        // The placeholder travels; a key never does.
        assertTrue(forwarded.contains("{{credential.token}}"))

        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
        coVerify(exactly = 0) { repository.deleteCustomerTool(any(), any()) }
    }

    @Test
    fun `a header holding a literal key is refused before anything is sent`() = runTest {
        val service = serviceReturning(discoverResponse)

        val e = assertFailsWith<IllegalArgumentException> {
            service.discoverMcp(
                "cust-1",
                DiscoverMcpConnectorRequest(
                    serverUrl = "https://mcp.notion.com/mcp",
                    headers = mapOf("Authorization" to "Bearer ntn_secret_value"),
                ),
            )
        }

        assertTrue(e.message!!.contains("credential"), "Expected a message pointing at the ref: ${e.message}")
        assertTrue(requestBodies.isEmpty(), "A credential value must never leave the proxy")
    }

    @Test
    fun `an unreachable retrieval server becomes a failed result, not an exception`() = runTest {
        val service = serviceReturning("""{"detail":"boom"}""", HttpStatusCode.InternalServerError)

        val result = service.previewOpenApi("cust-1", PreviewOpenApiConnectorRequest(specUrl = specUrl))

        assertFalse(result.ok)
        assertTrue(result.error!!.isNotBlank())
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    // ── Import is all-or-nothing ──────────────────────────────────────────────

    @Test
    fun `a batch with bad operations is rejected whole, naming each one and why`() = runTest {
        val service = serviceReturning(previewResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        val e = assertFailsWith<IllegalArgumentException> {
            service.importOpenApi(
                "cust-1",
                ImportOpenApiConnectorRequest(
                    specUrl = specUrl,
                    credentialRef = "EXAMPLE",
                    operations = listOf(
                        operation(name = "list_issues"),
                        operation(
                            name = "close_issue",
                            requestTemplate = """{"method":"GET","url":"http://api.example.com/v1/close"}""",
                        ),
                        operation(name = "Create Issue", path = "/v1/issues"),
                        operation(name = "short_desc", description = "too short"),
                    ),
                )
            )
        }

        val message = e.message!!
        assertTrue(message.contains("Nothing was imported"), "Expected an all-or-nothing message: $message")
        assertTrue(message.contains("3 of 4"), "Expected the failure count: $message")
        // Each bad operation is named, with the reason the customer can act on.
        assertTrue(message.contains("close_issue"), message)
        assertTrue(message.contains("https"), message)
        assertTrue(message.contains("Create Issue"), message)
        assertTrue(message.contains("short_desc"), message)
        assertTrue(message.contains("too short") || message.contains("at least"), message)
        // The one good operation is not named as a failure.
        assertFalse(message.contains("list_issues"), "A valid operation must not be blamed: $message")

        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    @Test
    fun `a valid batch is saved as openapi drafts pointing back at the spec`() = runTest {
        val service = serviceReturning(previewResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        val result = service.importOpenApi(
            "cust-1",
            ImportOpenApiConnectorRequest(
                specUrl = specUrl,
                credentialRef = "EXAMPLE",
                operations = listOf(operation(name = "list_issues"), operation(name = "close_issue")),
            )
        )

        assertEquals(2, result.tools.size)
        result.tools.forEach { tool ->
            assertEquals("draft", tool.status, "Import never activates a tool; its dry run does")
            assertEquals("openapi", tool.origin)
            assertEquals(specUrl, tool.originRef)
            assertEquals("http", tool.provider)
            assertEquals("EXAMPLE", tool.credentialRef)
            assertTrue(tool.lastDryRunAt.isBlank())
        }

        assertEquals(ConnectorsService.slugFor(specUrl), result.connector.id)
        assertEquals("openapi", result.connector.kind)
        assertEquals(specUrl, result.connector.ref)
        assertEquals(2, result.connector.toolCount)

        coVerify(exactly = 1) { repository.saveCustomerTool("cust-1", match { it.name == "list_issues" }) }
        coVerify(exactly = 1) { repository.saveCustomerTool("cust-1", match { it.name == "close_issue" }) }
    }

    @Test
    fun `two operations with the same name are rejected rather than overwriting each other`() = runTest {
        val service = serviceReturning(previewResponse)

        val e = assertFailsWith<IllegalArgumentException> {
            service.importOpenApi(
                "cust-1",
                ImportOpenApiConnectorRequest(
                    specUrl = specUrl,
                    operations = listOf(operation(name = "list_issues"), operation(name = "list_issues")),
                )
            )
        }

        assertTrue(e.message!!.contains("list_issues"))
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    @Test
    fun `an empty selection imports nothing and says so`() = runTest {
        val service = serviceReturning(previewResponse)

        val e = assertFailsWith<IllegalArgumentException> {
            service.importOpenApi("cust-1", ImportOpenApiConnectorRequest(specUrl = specUrl))
        }

        assertTrue(e.message!!.contains("nothing to import"))
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    @Test
    fun `a selection past the cap is refused before anything is written`() = runTest {
        val service = serviceReturning(previewResponse)
        val tooMany = (1..ConnectorsService.MAX_IMPORTED_OPERATIONS + 1).map { operation(name = "tool_$it") }

        val e = assertFailsWith<IllegalArgumentException> {
            service.importOpenApi("cust-1", ImportOpenApiConnectorRequest(specUrl = specUrl, operations = tooMany))
        }

        assertTrue(e.message!!.contains("${ConnectorsService.MAX_IMPORTED_OPERATIONS}"))
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    @Test
    fun `importing never calls the retrieval server`() = runTest {
        val service = serviceReturning(previewResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        service.importOpenApi(
            "cust-1",
            ImportOpenApiConnectorRequest(specUrl = specUrl, operations = listOf(operation())),
        )

        assertTrue(requestBodies.isEmpty(), "Import saves what preview already returned")
    }

    // ── Connecting an MCP server pins the approved manifest ───────────────────

    @Test
    fun `connect saves one mcp row with the approved manifest`() = runTest {
        val service = serviceReturning(discoverResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        val result = service.connectMcp(
            "cust-1",
            ConnectMcpConnectorRequest(
                name = "notion_workspace",
                description = "The customer's Notion workspace, over MCP.",
                serverUrl = "https://mcp.notion.com/mcp",
                credentialRef = "NOTION",
                headers = mapOf("Authorization" to "Bearer {{credential.token}}"),
                tools = listOf(
                    McpConnectorTool("search", "Search pages.", element("""{"type":"object"}""")),
                    McpConnectorTool("create_page", "Create a page.", element("""{"type":"object"}""")),
                ),
            )
        )

        val saved = result.tool
        assertEquals("mcp", saved.provider)
        assertEquals("draft", saved.status)
        assertEquals("notion_workspace", saved.name)
        assertEquals("NOTION", saved.credentialRef)
        assertTrue(saved.request.contains("https://mcp.notion.com/mcp"))
        assertTrue(saved.discoveredTools.contains(""""name":"search""""))
        assertTrue(saved.discoveredTools.contains(""""name":"create_page""""))

        assertEquals("notion_workspace", result.connector.id)
        assertEquals("mcp", result.connector.kind)
        assertEquals(2, result.connector.toolCount)
        assertEquals("https://mcp.notion.com/mcp", result.connector.ref)

        coVerify(exactly = 1) { repository.saveCustomerTool("cust-1", match { it.provider == "mcp" }) }
        assertTrue(requestBodies.isEmpty(), "Connect pins what discovery already returned")
    }

    @Test
    fun `a plain-words label becomes a valid tool name and description`() = runTest {
        val service = serviceReturning(discoverResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        val result = service.connectMcp(
            "cust-1",
            ConnectMcpConnectorRequest(
                serverUrl = "https://mcp.notion.com/mcp",
                label = "Notion workspace",
                credentialRef = "NOTION",
                tools = listOf(McpConnectorTool("search", "Search pages.")),
            )
        )

        // The UI asks for words a person would use; the sort key is derived.
        assertEquals("notion_workspace", result.tool.name)
        assertTrue(result.tool.description.length >= 10, result.tool.description)
        assertTrue(result.tool.description.contains("Notion workspace"), result.tool.description)
    }

    @Test
    fun `connecting a server with no approved tools is refused`() = runTest {
        val service = serviceReturning(discoverResponse)

        val e = assertFailsWith<IllegalArgumentException> {
            service.connectMcp(
                "cust-1",
                ConnectMcpConnectorRequest(
                    name = "notion_workspace",
                    description = "The customer's Notion workspace, over MCP.",
                    serverUrl = "https://mcp.notion.com/mcp",
                    tools = emptyList(),
                ),
            )
        }

        assertTrue(e.message!!.contains("Approve at least one"))
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    @Test
    fun `connecting a plaintext server is refused by the tool validator`() = runTest {
        val service = serviceReturning(discoverResponse)

        val e = assertFailsWith<IllegalArgumentException> {
            service.connectMcp(
                "cust-1",
                ConnectMcpConnectorRequest(
                    name = "notion_workspace",
                    description = "The customer's Notion workspace, over MCP.",
                    serverUrl = "http://mcp.notion.com/mcp",
                    tools = listOf(McpConnectorTool("search", "Search pages.")),
                ),
            )
        }

        assertTrue(e.message!!.contains("https"))
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    // ── A derived name must never clobber someone else's connector ────────────

    private fun mcpRow(name: String, serverUrl: String) = com.genflowly.models.api.CustomerTool(
        name = name,
        description = "An MCP server the customer connected earlier.",
        parameters = "",
        provider = "mcp",
        request = """{"url":"$serverUrl"}""",
        credentialRef = "",
        responseTransform = "",
        discoveredTools = """[{"name":"search"}]""",
        status = "draft",
        originRef = serverUrl,
    )

    private fun connectRequest(label: String, serverUrl: String) = ConnectMcpConnectorRequest(
        serverUrl = serverUrl,
        label = label,
        credentialRef = "",
        headers = emptyMap(),
        tools = listOf(McpConnectorTool("search", "Search.", element("""{"type":"object"}"""))),
    )

    @Test
    fun `a derived name is used as is when nothing holds it`() = runTest {
        val service = serviceReturning(discoverResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        val result = service.connectMcp("cust-1", connectRequest("Notion", "https://mcp.notion.com/mcp"))

        assertEquals("notion", result.tool.name)
    }

    @Test
    fun `a different server deriving the same name gets a suffix, not the other's row`() = runTest {
        // Two labels can slug to the same thing, and the fallback chain ends at
        // a constant. Overwriting would silently delete a working connector.
        val service = serviceReturning(discoverResponse)
        coEvery { repository.getCustomerTool("cust-1", "notion") } returns
            mcpRow("notion", "https://mcp.other.com/mcp")
        coEvery { repository.getCustomerTool("cust-1", "notion_2") } returns null

        val result = service.connectMcp("cust-1", connectRequest("Notion", "https://mcp.notion.com/mcp"))

        assertEquals("notion_2", result.tool.name)
    }

    @Test
    fun `reconnecting the same server reuses its row rather than piling up`() = runTest {
        // This is how a changed manifest gets re-approved; it must update.
        val service = serviceReturning(discoverResponse)
        coEvery { repository.getCustomerTool("cust-1", "notion") } returns
            mcpRow("notion", "https://mcp.notion.com/mcp")

        val result = service.connectMcp("cust-1", connectRequest("Notion", "https://mcp.notion.com/mcp"))

        assertEquals("notion", result.tool.name)
    }

    @Test
    fun `an explicitly supplied name keeps upsert semantics`() = runTest {
        // An explicit name is a choice someone made; honour it.
        val service = serviceReturning(discoverResponse)
        coEvery { repository.getCustomerTool("cust-1", "notion_workspace") } returns
            mcpRow("notion_workspace", "https://mcp.other.com/mcp")

        val result = service.connectMcp(
            "cust-1",
            connectRequest("Notion", "https://mcp.notion.com/mcp").copy(name = "notion_workspace"),
        )

        assertEquals("notion_workspace", result.tool.name)
    }

    @Test
    fun `a label that cannot form a name still lands on a legal one`() = runTest {
        val service = serviceReturning(discoverResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        val result = service.connectMcp("cust-1", connectRequest("!!!", "https://mcp.notion.com/mcp"))

        assertTrue(Regex("^[a-z][a-z0-9_]{2,63}$").matches(result.tool.name), result.tool.name)
    }
}
