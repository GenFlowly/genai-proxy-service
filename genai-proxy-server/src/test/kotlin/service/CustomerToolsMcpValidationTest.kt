package com.genflowly.service

import com.genflowly.models.api.UpsertCustomerToolRequest
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Validation of `provider: "mcp"` records.
 *
 * An MCP record describes a SERVER rather than a call, so almost none of the
 * http rules apply: there is no method, no body, no response transform, and each
 * discovered tool carries its own argument schema. What is checked instead is
 * that the server is reachable only over https at a fixed address, and that the
 * tool list was approved rather than left to be discovered at bind time.
 *
 * As elsewhere, messages are asserted on loosely because the editor shows them
 * to the customer verbatim.
 */
class CustomerToolsMcpValidationTest {

    private val defaultManifest = """
        [{"name":"search","description":"Search pages.",
          "inputSchema":{"type":"object","properties":{"q":{"type":"string"}}}},
         {"name":"create-page","description":"Create a page.",
          "inputSchema":{"type":"object","properties":{}}}]
    """.trimIndent()

    private val defaultServer = """
        {"url":"https://mcp.notion.com/mcp",
         "headers":{"Authorization":"Bearer {{credential.token}}"}}
    """.trimIndent()

    private fun mcpRequest(
        name: String = "notion",
        description: String = "The customer's Notion workspace, over MCP.",
        requestTemplate: String = defaultServer,
        discoveredTools: String = defaultManifest,
        credentialRef: String = "NOTION",
        status: String = "draft",
        lastDryRunAt: String = "",
    ) = UpsertCustomerToolRequest(
        name = name,
        description = description,
        provider = "mcp",
        request = requestTemplate,
        discoveredTools = discoveredTools,
        credentialRef = credentialRef,
        status = status,
        lastDryRunAt = lastDryRunAt,
    )

    // ── happy path ────────────────────────────────────────────────────────────

    @Test
    fun `a well formed mcp record is accepted`() {
        CustomerToolValidator.validate(mcpRequest())
    }

    @Test
    fun `an mcp record needs no parameters or response transform`() {
        // Both default to "" — each discovered tool brings its own schema, and
        // MCP results are already content blocks.
        val request = mcpRequest()
        assertTrue(request.parameters.isEmpty())
        assertTrue(request.responseTransform.isEmpty())
        CustomerToolValidator.validate(request)
    }

    @Test
    fun `an mcp record with no credential is accepted`() {
        CustomerToolValidator.validate(
            mcpRequest(
                requestTemplate = """{"url":"https://mcp.example.com/mcp"}""",
                credentialRef = "",
            )
        )
    }

    // ── the server address ────────────────────────────────────────────────────

    @Test
    fun `a missing server url is rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(requestTemplate = """{"headers":{}}"""))
        }
        assertTrue(error.message!!.contains("url", ignoreCase = true))
    }

    @Test
    fun `a plaintext server url is rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(
                mcpRequest(requestTemplate = """{"url":"http://mcp.example.com/mcp"}""")
            )
        }
        assertTrue(error.message!!.contains("https"))
    }

    @Test
    fun `a templated server url is rejected`() {
        // The property the whole tier rests on: the destination is fixed when
        // the tool is connected, so nothing supplied at call time can move it.
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(
                mcpRequest(requestTemplate = """{"url":"https://{{args.host}}/mcp"}""")
            )
        }
        assertTrue(error.message!!.contains("placeholder", ignoreCase = true))
    }

    @Test
    fun `unexpected keys in an mcp request are rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(
                mcpRequest(
                    requestTemplate = """{"url":"https://mcp.example.com/mcp","method":"POST"}"""
                )
            )
        }
        assertTrue(error.message!!.contains("method"))
    }

    // ── headers ───────────────────────────────────────────────────────────────

    @Test
    fun `an args placeholder in a header is rejected`() {
        // Headers are sent when the connection opens, before any tool call has
        // arguments, so {{args.*}} there can never resolve.
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(
                mcpRequest(
                    requestTemplate = """
                        {"url":"https://mcp.example.com/mcp",
                         "headers":{"X-Q":"{{args.q}}"}}
                    """.trimIndent()
                )
            )
        }
        assertTrue(error.message!!.contains("credential"))
    }

    @Test
    fun `a malformed placeholder in a header is rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(
                mcpRequest(
                    requestTemplate = """
                        {"url":"https://mcp.example.com/mcp",
                         "headers":{"Authorization":"Bearer {{env.TOKEN}}"}}
                    """.trimIndent()
                )
            )
        }
        assertTrue(error.message!!.contains("placeholder", ignoreCase = true))
    }

    // ── the pinned manifest ───────────────────────────────────────────────────

    @Test
    fun `a record with no approved tool list is rejected`() {
        // Binding never calls the server, so an unapproved record would bind
        // nothing at all. Reject it here where the message can explain why.
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(discoveredTools = ""))
        }
        assertTrue(error.message!!.contains("approve", ignoreCase = true))
    }

    @Test
    fun `an empty tool list is rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(discoveredTools = "[]"))
        }
        assertTrue(error.message!!.contains("empty", ignoreCase = true))
    }

    @Test
    fun `a malformed tool list is rejected`() {
        assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(discoveredTools = "{not json"))
        }
    }

    @Test
    fun `a tool list that is not an array is rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(discoveredTools = """{"name":"search"}"""))
        }
        assertTrue(error.message!!.contains("array", ignoreCase = true))
    }

    @Test
    fun `a manifest entry without a name is rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(
                mcpRequest(discoveredTools = """[{"description":"no name here"}]""")
            )
        }
        assertTrue(error.message!!.contains("name", ignoreCase = true))
    }

    @Test
    fun `a manifest entry that is not an object is rejected`() {
        assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(discoveredTools = """["search"]"""))
        }
    }

    // ── rules shared with http ────────────────────────────────────────────────

    @Test
    fun `the name rules still apply`() {
        assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(name = "Notion Workspace"))
        }
    }

    @Test
    fun `a name colliding with a built-in is still rejected`() {
        assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(name = "web_search"))
        }
    }

    @Test
    fun `activating without a dry run is still rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(mcpRequest(status = "active", lastDryRunAt = ""))
        }
        assertTrue(error.message!!.contains("dry run", ignoreCase = true))
    }

    @Test
    fun `an mcp record may be activated once it has a dry run`() {
        CustomerToolValidator.validate(
            mcpRequest(status = "active", lastDryRunAt = "2026-09-22T10:00:00Z")
        )
    }

    @Test
    fun `an unknown provider is still rejected`() {
        val error = assertFailsWith<IllegalArgumentException> {
            CustomerToolValidator.validate(
                UpsertCustomerToolRequest(
                    name = "thing",
                    description = "A tool backed by something we do not support.",
                    provider = "grpc",
                    request = """{"url":"https://example.com"}""",
                )
            )
        }
        assertTrue(error.message!!.contains("provider", ignoreCase = true))
    }
}
