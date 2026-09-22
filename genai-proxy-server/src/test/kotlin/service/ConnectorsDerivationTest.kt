package com.genflowly.service

import com.genflowly.models.api.CustomerTool
import com.genflowly.repository.CustomerToolsRepository
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Connectors have no table: the list is *derived* by grouping the rows that
 * already exist, so the interesting behaviour is which rows become a connector,
 * which are invisible, and what a disconnect actually deletes.
 *
 * The mixed row set below is the point of the fixture — a customer's tools are
 * a jumble of hand-written rows, rows from two different specs and an MCP
 * server, and the grouping has to sort that out without a stored marker.
 */
class ConnectorsDerivationTest {

    private val repository = mockk<CustomerToolsRepository>(relaxed = true)

    private fun service() = ConnectorsService(
        customerToolsRepository = repository,
        json = Json { ignoreUnknownKeys = true },
        httpClient = HttpClient(MockEngine { respond("{}") }),
        retrievalServerUrl = "http://retrieval:8000",
    )

    private val exampleSpec = "https://api.example.com/openapi.json"
    private val otherSpec = "https://other.example.org/v2/spec.yaml"

    private fun httpRow(
        name: String,
        origin: String = "openapi",
        originRef: String = exampleSpec,
        credentialRef: String = "EXAMPLE",
        createdAt: String = "2026-02-01T00:00:00Z",
    ) = CustomerTool(
        name = name,
        description = "An imported operation from a spec.",
        parameters = """{"type":"object","properties":{}}""",
        provider = "http",
        request = """{"method":"GET","url":"https://api.example.com/v1/$name"}""",
        credentialRef = credentialRef,
        responseTransform = """{"mode":"text"}""",
        status = "draft",
        origin = origin,
        originRef = originRef,
        createdAt = createdAt,
    )

    private val mcpRow = CustomerTool(
        name = "notion_workspace",
        description = "The customer's Notion workspace, over MCP.",
        parameters = "",
        provider = "mcp",
        request = """{"url":"https://mcp.notion.com/mcp",
                      "headers":{"Authorization":"Bearer {{credential.token}}"}}""",
        credentialRef = "NOTION",
        responseTransform = "",
        discoveredTools = """[{"name":"search","description":"Search pages."},
                              {"name":"create_page","description":"Create a page."},
                              {"name":"append_block","description":"Append a block."}]""",
        status = "draft",
        origin = "manual",
        originRef = "https://mcp.notion.com/mcp",
        createdAt = "2026-03-01T00:00:00Z",
    )

    /** Two specs, one MCP server, one hand-written tool, one unattributed row. */
    private val mixedRows = listOf(
        httpRow("list_issues", createdAt = "2026-02-01T00:00:00Z"),
        httpRow("create_issue", createdAt = "2026-01-15T00:00:00Z", credentialRef = ""),
        httpRow("close_issue", createdAt = "2026-02-02T00:00:00Z"),
        httpRow("fetch_weather", originRef = otherSpec, credentialRef = "WEATHER"),
        httpRow("send_email", origin = "manual", originRef = "", credentialRef = "SMTP"),
        // origin says openapi but nothing says which spec: it belongs to no
        // connector and must not become one of its own.
        httpRow("orphan_tool", originRef = ""),
        mcpRow,
    )

    // ── Grouping ──────────────────────────────────────────────────────────────

    @Test
    fun `connectors are derived by grouping a mixed set of rows`() = runTest {
        coEvery { repository.listCustomerTools("cust-1") } returns mixedRows

        val connectors = service().listConnectors("cust-1").connectors

        assertEquals(3, connectors.size, "Expected two specs and one MCP server, got: $connectors")

        val example = connectors.single { it.ref == exampleSpec }
        assertEquals("openapi", example.kind)
        assertEquals(3, example.toolCount, "The three rows sharing the spec url are one connector")
        assertEquals("api.example.com", example.label)
        assertEquals("EXAMPLE", example.credentialRef)
        assertEquals("2026-01-15T00:00:00Z", example.connectedAt, "Connected when its oldest row was")

        val other = connectors.single { it.ref == otherSpec }
        assertEquals("openapi", other.kind)
        assertEquals(1, other.toolCount)
        assertEquals("WEATHER", other.credentialRef)
        assertNotEquals(example.id, other.id, "Two specs are two connectors")

        val notion = connectors.single { it.kind == "mcp" }
        assertEquals("notion_workspace", notion.id, "An MCP connector is identified by its row name")
        assertEquals("https://mcp.notion.com/mcp", notion.ref)
        assertEquals("mcp.notion.com", notion.label)
        assertEquals(3, notion.toolCount, "An MCP server's tool count is its approved manifest")
        assertEquals("NOTION", notion.credentialRef)
        assertEquals("2026-03-01T00:00:00Z", notion.connectedAt)
    }

    @Test
    fun `hand-written and unattributed tools belong to no connector`() = runTest {
        coEvery { repository.listCustomerTools("cust-1") } returns mixedRows

        val refs = service().listConnectors("cust-1").connectors.map { it.ref }

        assertTrue(refs.none { it.isBlank() }, "A row with no originRef cannot become a connector")
        assertEquals(setOf(exampleSpec, otherSpec, "https://mcp.notion.com/mcp"), refs.toSet())
    }

    @Test
    fun `a customer with no tools has no connectors`() = runTest {
        coEvery { repository.listCustomerTools("cust-1") } returns emptyList()

        assertEquals(emptyList(), service().listConnectors("cust-1").connectors)
    }

    @Test
    fun `a spec id is a stable slug of its url`() {
        val id = ConnectorsService.slugFor(exampleSpec)

        assertEquals(id, ConnectorsService.slugFor(exampleSpec), "The same url must always give the same id")
        assertEquals(id, ConnectorsService.slugFor("  $exampleSpec  "), "Surrounding space is not identity")
        assertNotEquals(id, ConnectorsService.slugFor(otherSpec))
        assertTrue(id.startsWith("api-example-com-openapi-json-"), "Expected a readable slug, got: $id")
        // An MCP id is a tool name, which can never contain '-', so the two
        // kinds of connector id cannot collide in the {id} path.
        assertTrue(id.contains('-'))
    }

    @Test
    fun `two spec urls differing only in a long path stay distinct`() {
        val a = "https://api.example.com/some/very/long/path/that/goes/on/and/on/alpha.json"
        val b = "https://api.example.com/some/very/long/path/that/goes/on/and/on/beta.json"

        assertNotEquals(ConnectorsService.slugFor(a), ConnectorsService.slugFor(b))
    }

    // ── Disconnecting ─────────────────────────────────────────────────────────

    @Test
    fun `deleting a spec connector removes every row it produced and counts them`() = runTest {
        coEvery { repository.listCustomerTools("cust-1") } returns mixedRows
        val id = ConnectorsService.slugFor(exampleSpec)

        val result = service().deleteConnector("cust-1", id)

        assertEquals(id, result.id)
        assertEquals(3, result.removed)
        assertEquals(3, result.rowsDeleted)
        coVerify(exactly = 1) { repository.deleteCustomerTool("cust-1", "list_issues") }
        coVerify(exactly = 1) { repository.deleteCustomerTool("cust-1", "create_issue") }
        coVerify(exactly = 1) { repository.deleteCustomerTool("cust-1", "close_issue") }
        // Everything belonging to another connector, or to none, survives.
        coVerify(exactly = 0) { repository.deleteCustomerTool("cust-1", "fetch_weather") }
        coVerify(exactly = 0) { repository.deleteCustomerTool("cust-1", "send_email") }
        coVerify(exactly = 0) { repository.deleteCustomerTool("cust-1", "orphan_tool") }
        coVerify(exactly = 0) { repository.deleteCustomerTool("cust-1", "notion_workspace") }
    }

    @Test
    fun `deleting an MCP connector removes one row but reports the tools it took away`() = runTest {
        coEvery { repository.listCustomerTools("cust-1") } returns mixedRows

        val result = service().deleteConnector("cust-1", "notion_workspace")

        assertEquals(3, result.removed, "The customer was shown three tools, so three went away")
        assertEquals(1, result.rowsDeleted, "An MCP server is a single row")
        coVerify(exactly = 1) { repository.deleteCustomerTool("cust-1", "notion_workspace") }
        coVerify(exactly = 0) { repository.deleteCustomerTool("cust-1", "list_issues") }
    }

    @Test
    fun `deleting an unknown connector is a not-found and deletes nothing`() = runTest {
        coEvery { repository.listCustomerTools("cust-1") } returns mixedRows

        val e = assertFailsWith<IllegalStateException> {
            service().deleteConnector("cust-1", "no-such-connector-0000")
        }

        assertTrue(e.message!!.contains("not found"))
        coVerify(exactly = 0) { repository.deleteCustomerTool(any(), any()) }
    }

    @Test
    fun `a hand-written tool's name is not a connector id`() = runTest {
        coEvery { repository.listCustomerTools("cust-1") } returns mixedRows

        assertFailsWith<IllegalStateException> { service().deleteConnector("cust-1", "send_email") }
        coVerify(exactly = 0) { repository.deleteCustomerTool(any(), any()) }
    }
}
