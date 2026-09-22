package com.genflowly.service

import com.genflowly.models.api.CustomerTool
import com.genflowly.models.api.DryRunCustomerToolRequest
import com.genflowly.models.api.UpsertCustomerToolRequest
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
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The dry-run forwarding layer. The behaviour worth pinning down is that a bad
 * definition never reaches the network, that customerId comes from the caller
 * rather than the body, and that a successful run is what stamps lastDryRunAt.
 */
class CustomerToolsDryRunTest {

    private val repository = mockk<CustomerToolsRepository>(relaxed = true)
    private val json = Json { ignoreUnknownKeys = true }

    private val requestBodies = mutableListOf<String>()

    private fun serviceReturning(
        responseBody: String,
        status: HttpStatusCode = HttpStatusCode.OK,
    ): CustomerToolsService {
        val engine = MockEngine { request ->
            requestBodies += String((request.body as io.ktor.http.content.OutgoingContent.ByteArrayContent).bytes())
            respond(
                content = responseBody,
                status = status,
                headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
            )
        }
        return CustomerToolsService(
            customerToolsRepository = repository,
            json = json,
            httpClient = HttpClient(engine),
            retrievalServerUrl = "http://retrieval:8000",
        )
    }

    private fun validDraft(
        name: String = "create_linear_issue",
        description: String = "Create an issue in the customer's Linear workspace.",
        parameters: String = """{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}""",
        requestTemplate: String = """{"method":"POST","url":"https://api.example.com/v1/issues",
            "headers":{"Authorization":"Bearer {{credential.api_key}}"},
            "body":{"title":"{{args.title}}"},"bodyType":"json"}""",
        responseTransform: String = """{"mode":"json_path","path":"data.issue.identifier"}""",
    ) = UpsertCustomerToolRequest(
        name = name,
        description = description,
        parameters = parameters,
        request = requestTemplate,
        credentialRef = "LINEAR",
        responseTransform = responseTransform,
    )

    private val okResponse = """
        {"ok":true,
         "request":{"method":"POST","url":"https://api.example.com/v1/issues","headers":{},"query":{},"body":null},
         "response":{"status_code":201,"body":"{}","truncated":false},
         "model_sees":"ENG-1","error":null}
    """.trimIndent()

    private val storedTool = CustomerTool(
        name = "create_linear_issue",
        description = "Create an issue in the customer's Linear workspace.",
        parameters = """{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}""",
        request = """{"method":"POST","url":"https://api.example.com/v1/issues","body":{"title":"{{args.title}}"}}""",
        credentialRef = "LINEAR",
        responseTransform = """{"mode":"text"}""",
        status = "draft",
        version = 3,
        createdAt = "2026-01-01T00:00:00Z",
    )

    // ── Validation happens before anything is forwarded ────────────────────────

    @Test
    fun `an invalid draft is rejected before the retrieval server is called`() = runTest {
        val service = serviceReturning(okResponse)
        val e = assertFailsWith<IllegalArgumentException> {
            service.dryRunTool(
                customerId = "cust-1",
                name = "create_linear_issue",
                request = DryRunCustomerToolRequest(
                    tool = validDraft(requestTemplate = """{"method":"GET","url":"http://api.example.com/v1/x"}""")
                ),
            )
        }
        assertTrue(e.message!!.contains("https"), "Expected the validator's message, got: ${e.message}")
        assertTrue(requestBodies.isEmpty(), "Nothing may be forwarded when validation fails")
        coVerify(exactly = 0) { repository.getCustomerTool(any(), any()) }
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    @Test
    fun `a draft with a placeholder in the host never reaches the network`() = runTest {
        val service = serviceReturning(okResponse)
        assertFailsWith<IllegalArgumentException> {
            service.dryRunTool(
                "cust-1",
                "create_linear_issue",
                DryRunCustomerToolRequest(
                    tool = validDraft(
                        requestTemplate = """{"method":"GET","url":"https://{{args.title}}.example.com/x"}"""
                    )
                ),
            )
        }
        assertTrue(requestBodies.isEmpty())
    }

    @Test
    fun `a stored definition is validated too`() = runTest {
        val service = serviceReturning(okResponse)
        coEvery { repository.getCustomerTool("cust-1", "create_linear_issue") } returns
            storedTool.copy(request = """{"method":"GET","url":"http://insecure.example.com/x"}""")

        val e = assertFailsWith<IllegalArgumentException> {
            service.dryRunTool("cust-1", "create_linear_issue", DryRunCustomerToolRequest())
        }
        assertTrue(e.message!!.contains("https"))
        assertTrue(requestBodies.isEmpty())
    }

    @Test
    fun `the body definition must agree with the path name`() = runTest {
        val service = serviceReturning(okResponse)
        val e = assertFailsWith<IllegalArgumentException> {
            service.dryRunTool("cust-1", "other_tool", DryRunCustomerToolRequest(tool = validDraft()))
        }
        assertTrue(e.message!!.contains("must match"))
        assertTrue(requestBodies.isEmpty())
    }

    @Test
    fun `no definition and no stored row is a not-found`() = runTest {
        val service = serviceReturning(okResponse)
        coEvery { repository.getCustomerTool("cust-1", "create_linear_issue") } returns null

        val e = assertFailsWith<IllegalStateException> {
            service.dryRunTool("cust-1", "create_linear_issue", DryRunCustomerToolRequest())
        }
        assertTrue(e.message!!.contains("not found"))
        assertTrue(requestBodies.isEmpty())
    }

    // ── Forwarding ────────────────────────────────────────────────────────────

    @Test
    fun `a valid unsaved draft is forwarded with the authenticated customerId`() = runTest {
        val service = serviceReturning(okResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        val result = service.dryRunTool(
            customerId = "cust-1",
            name = "create_linear_issue",
            request = DryRunCustomerToolRequest(
                tool = validDraft(),
                args = mapOf("title" to JsonPrimitive("Ship it")),
            ),
        )

        assertTrue(result.ok)
        assertEquals("ENG-1", result.model_sees)
        assertEquals(201, result.response?.status_code)

        assertEquals(1, requestBodies.size)
        val forwarded = requestBodies.single()
        assertTrue(forwarded.contains(""""customer_id":"cust-1""""))
        assertTrue(forwarded.contains("create_linear_issue"))
        assertTrue(forwarded.contains("Ship it"))
        // The credential reference travels; no credential value ever does.
        assertTrue(forwarded.contains("LINEAR"))
        // Fields holding their default value must still be on the wire.
        assertTrue(forwarded.contains(""""provider":"http""""), "provider missing from: $forwarded")
        assertTrue(forwarded.contains(""""status":"draft""""), "status missing from: $forwarded")
        assertTrue(forwarded.contains(""""version":"""), "version missing from: $forwarded")
    }

    @Test
    fun `a successful dry run stamps lastDryRunAt on the stored row`() = runTest {
        val service = serviceReturning(okResponse)
        coEvery { repository.getCustomerTool("cust-1", "create_linear_issue") } returns storedTool

        service.dryRunTool("cust-1", "create_linear_issue", DryRunCustomerToolRequest())

        coVerify(exactly = 1) {
            repository.saveCustomerTool(
                "cust-1",
                match { it.name == "create_linear_issue" && it.lastDryRunAt.isNotBlank() && it.version == 3 },
            )
        }
    }

    @Test
    fun `a failed dry run does not stamp lastDryRunAt`() = runTest {
        val service = serviceReturning("""{"ok":false,"error":"401 from the upstream API"}""")
        coEvery { repository.getCustomerTool("cust-1", "create_linear_issue") } returns storedTool

        val result = service.dryRunTool("cust-1", "create_linear_issue", DryRunCustomerToolRequest())

        assertFalse(result.ok)
        assertEquals("401 from the upstream API", result.error)
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    @Test
    fun `an unsaved draft is never written back`() = runTest {
        val service = serviceReturning(okResponse)
        coEvery { repository.getCustomerTool(any(), any()) } returns null

        service.dryRunTool("cust-1", "create_linear_issue", DryRunCustomerToolRequest(tool = validDraft()))

        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    @Test
    fun `a retrieval-server error becomes a failed result, not an exception`() = runTest {
        val service = serviceReturning("""{"detail":"boom"}""", HttpStatusCode.InternalServerError)
        coEvery { repository.getCustomerTool(any(), any()) } returns storedTool

        val result = service.dryRunTool("cust-1", "create_linear_issue", DryRunCustomerToolRequest())

        assertFalse(result.ok)
        assertTrue(result.error!!.isNotBlank())
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }
}
