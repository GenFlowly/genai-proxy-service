package com.genflowly.service

import com.genflowly.di.provideJson
import com.genflowly.models.api.UpsertCustomerToolRequest
import com.genflowly.repository.CustomerToolsRepository
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Every rejection rule of [CustomerToolValidator] plus the happy path.
 *
 * The messages are asserted on (loosely) because they are shown to the user
 * verbatim by the tool editor — a rule that fires with an unhelpful message is
 * only half implemented.
 */
class CustomerToolsValidationTest {

    private val defaultParameters = """
        {"type":"object",
         "properties":{
           "id":{"type":"string","description":"Issue id"},
           "limit":{"type":"integer"}
         },
         "required":["id"]}
    """.trimIndent()

    private val defaultRequest = """
        {"method":"GET",
         "url":"https://api.example.com/v1/issues/{{args.id}}",
         "headers":{"Authorization":"Bearer {{credential.api_key}}"},
         "query":{"limit":"{{args.limit}}"},
         "body":null}
    """.trimIndent()

    private fun request(
        name: String = "create_linear_issue",
        description: String = "Create an issue in the customer's Linear workspace.",
        parameters: String = defaultParameters,
        provider: String = "http",
        requestTemplate: String = defaultRequest,
        credentialRef: String = "LINEAR",
        responseTransform: String = """{"mode":"json_path","path":"data.issue.identifier","maxChars":8000}""",
        status: String = "draft",
        origin: String = "manual",
        originRef: String = "",
        lastDryRunAt: String = "",
    ) = UpsertCustomerToolRequest(
        name = name,
        description = description,
        parameters = parameters,
        provider = provider,
        request = requestTemplate,
        credentialRef = credentialRef,
        responseTransform = responseTransform,
        status = status,
        origin = origin,
        originRef = originRef,
        lastDryRunAt = lastDryRunAt,
    )

    private fun rejects(req: UpsertCustomerToolRequest, expectedFragment: String) {
        val e = assertFailsWith<IllegalArgumentException> { CustomerToolValidator.validate(req) }
        assertTrue(
            e.message!!.contains(expectedFragment, ignoreCase = true),
            "Expected message to mention '$expectedFragment' but was: ${e.message}"
        )
    }

    // ── Happy paths ───────────────────────────────────────────────────────────

    @Test
    fun `a complete valid tool passes`() {
        CustomerToolValidator.validate(request())
    }

    @Test
    fun `an active tool with a recorded dry run passes`() {
        CustomerToolValidator.validate(
            request(status = "active", lastDryRunAt = "2026-09-22T10:00:00Z")
        )
    }

    @Test
    fun `a POST tool with a templated body passes`() {
        CustomerToolValidator.validate(
            request(
                parameters = """{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}""",
                requestTemplate = """
                    {"method":"POST","url":"https://api.example.com/v1/issues",
                     "headers":{"Authorization":"Bearer {{credential.api_key}}"},
                     "body":{"title":"{{args.title}}"},"bodyType":"json"}
                """.trimIndent(),
            )
        )
    }

    @Test
    fun `a tool with no arguments and no credential passes`() {
        CustomerToolValidator.validate(
            request(
                parameters = """{"type":"object","properties":{}}""",
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/status"}""",
                credentialRef = "",
                responseTransform = """{"mode":"text"}""",
            )
        )
    }

    // ── name ──────────────────────────────────────────────────────────────────

    @Test
    fun `name must match the tool-name regex`() {
        rejects(request(name = "CreateIssue"), "not valid")      // uppercase
        rejects(request(name = "1create"), "not valid")           // leading digit
        rejects(request(name = "ab"), "not valid")                // too short
        rejects(request(name = "create-issue"), "not valid")      // hyphen
        rejects(request(name = "a".repeat(65)), "not valid")      // too long
        rejects(request(name = ""), "not valid")
        // 3 and 64 characters are the inclusive bounds.
        CustomerToolValidator.validate(request(name = "abc"))
        CustomerToolValidator.validate(request(name = "a".repeat(64)))
    }

    @Test
    fun `name may not collide with a built-in tool`() {
        rejects(request(name = "web_search"), "reserved")
        rejects(request(name = "generate_pdf"), "reserved")
    }

    @Test
    fun `names of the built-in tools being rolled out are reserved too`() {
        for (name in listOf("revise_pdf", "read_pdf_source", "read_attachment")) {
            rejects(request(name = name), "reserved")
        }
    }

    @Test
    fun `creating a customer tool named revise_pdf is rejected before anything is stored`() = runTest {
        val repository = mockk<CustomerToolsRepository>(relaxed = true)
        val service = CustomerToolsService(repository, provideJson(), mockk(relaxed = true), "http://retrieval-server")

        val e = assertFailsWith<IllegalArgumentException> { service.saveTool("cust-1", request(name = "revise_pdf")) }

        assertTrue(e.message!!.contains("reserved", ignoreCase = true), e.message)
        coVerify(exactly = 0) { repository.saveCustomerTool(any(), any()) }
    }

    // ── description ───────────────────────────────────────────────────────────

    @Test
    fun `description length is bounded`() {
        rejects(request(description = "too short"), "too short")
        rejects(request(description = "x".repeat(1025)), "too long")
        CustomerToolValidator.validate(request(description = "x".repeat(10)))
        CustomerToolValidator.validate(request(description = "x".repeat(1024)))
    }

    // ── provider / status / origin ────────────────────────────────────────────

    @Test
    fun `provider status and origin are closed sets`() {
        // "mcp" is supported now and has its own shape, so it is validated in
        // CustomerToolsMcpValidationTest rather than rejected here.
        rejects(request(provider = "grpc"), "provider")
        rejects(request(status = "enabled"), "status")
        rejects(request(origin = "imported"), "origin")
        CustomerToolValidator.validate(request(status = "disabled"))
        CustomerToolValidator.validate(request(origin = "openapi"))
    }

    @Test
    fun `active status requires a recorded dry run`() {
        rejects(request(status = "active", lastDryRunAt = ""), "test call")
        rejects(request(status = "active", lastDryRunAt = "   "), "test call")
    }

    // ── parameters ────────────────────────────────────────────────────────────

    @Test
    fun `parameters must be a JSON object`() {
        rejects(request(parameters = "not json"), "not valid JSON")
        rejects(request(parameters = """["a"]"""), "must be a JSON object")
    }

    @Test
    fun `parameters root must be type object with properties`() {
        rejects(request(parameters = """{"type":"string","properties":{}}"""), "\"type\": \"object\"")
        rejects(request(parameters = """{"type":"object"}"""), "properties")
    }

    @Test
    fun `parameters root rejects unsupported fields`() {
        rejects(
            request(parameters = """{"type":"object","properties":{},"${'$'}ref":"#/x"}"""),
            "unsupported field"
        )
    }

    @Test
    fun `parameters reject an additionalProperties schema object`() {
        rejects(
            request(parameters = """{"type":"object","properties":{},"additionalProperties":{"type":"string"}}"""),
            "additionalProperties"
        )
        // A plain boolean is fine.
        CustomerToolValidator.validate(
            request(
                parameters = """{"type":"object","properties":{},"additionalProperties":false}""",
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/status"}""",
            )
        )
    }

    @Test
    fun `property types are limited to the four scalars`() {
        rejects(
            request(parameters = """{"type":"object","properties":{"tags":{"type":"array"}},"required":[]}"""),
            "unsupported type"
        )
        rejects(
            request(parameters = """{"type":"object","properties":{"who":{"type":"object"}},"required":[]}"""),
            "unsupported type"
        )
        rejects(
            request(parameters = """{"type":"object","properties":{"who":{"description":"x"}},"required":[]}"""),
            "missing a 'type'"
        )
    }

    @Test
    fun `properties reject nesting and dollar-ref`() {
        // The nested "properties" key is caught as an unsupported field before
        // the (also illegal) "object" type is even reached.
        rejects(
            request(
                parameters = """{"type":"object","properties":
                    {"who":{"type":"object","properties":{"a":{"type":"string"}}}},"required":[]}"""
            ),
            "unsupported field"
        )
        rejects(
            request(
                parameters = """{"type":"object","properties":{"who":{"type":"string","${'$'}ref":"#/x"}},"required":[]}"""
            ),
            "unsupported field"
        )
        rejects(
            request(
                parameters = """{"type":"object","properties":{"who":{"type":"string","items":{}}},"required":[]}"""
            ),
            "unsupported field"
        )
    }

    @Test
    fun `at most twenty properties are allowed`() {
        val props = (1..21).joinToString(",") { """"p$it":{"type":"string"}""" }
        rejects(request(parameters = """{"type":"object","properties":{$props},"required":[]}"""), "maximum is 20")

        val twenty = (1..20).joinToString(",") { """"p$it":{"type":"string"}""" }
        CustomerToolValidator.validate(
            request(
                parameters = """{"type":"object","properties":{$twenty},"required":[]}""",
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/status"}""",
            )
        )
    }

    @Test
    fun `required must name declared properties`() {
        rejects(
            request(parameters = """{"type":"object","properties":{"id":{"type":"string"}},"required":["nope"]}"""),
            "no such property"
        )
        rejects(
            request(parameters = """{"type":"object","properties":{"id":{"type":"string"}},"required":"id"}"""),
            "must be an array"
        )
    }

    @Test
    fun `enum must be a non-empty array of scalars`() {
        rejects(
            request(
                parameters = """{"type":"object","properties":{"id":{"type":"string","enum":[]}},"required":[]}"""
            ),
            "non-empty array"
        )
        rejects(
            request(
                parameters = """{"type":"object","properties":{"id":{"type":"string","enum":[{"a":1}]}},"required":[]}"""
            ),
            "non-scalar"
        )
        CustomerToolValidator.validate(
            request(
                parameters = """{"type":"object","properties":{"id":{"type":"string","enum":["a","b"]}},"required":[]}""",
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/issues/{{args.id}}"}""",
            )
        )
    }

    // ── request template ──────────────────────────────────────────────────────

    @Test
    fun `request must be a JSON object with the allowed fields`() {
        rejects(request(requestTemplate = "{"), "not valid JSON")
        rejects(
            request(requestTemplate = """{"method":"GET","url":"https://a.example.com/x","timeout":5}"""),
            "unsupported field"
        )
    }

    @Test
    fun `method must be in the allowed set`() {
        rejects(
            request(requestTemplate = """{"method":"HEAD","url":"https://api.example.com/v1/x"}"""),
            "is not allowed"
        )
        rejects(
            request(requestTemplate = """{"method":"get","url":"https://api.example.com/v1/x"}"""),
            "is not allowed"
        )
        rejects(request(requestTemplate = """{"url":"https://api.example.com/v1/x"}"""), "missing a 'method'")
        for (method in listOf("GET", "POST", "PUT", "PATCH", "DELETE")) {
            CustomerToolValidator.validate(
                request(requestTemplate = """{"method":"$method","url":"https://api.example.com/v1/x"}""")
            )
        }
    }

    @Test
    fun `url must be https`() {
        rejects(
            request(requestTemplate = """{"method":"GET","url":"http://api.example.com/v1/x"}"""),
            "must use https"
        )
        rejects(
            request(requestTemplate = """{"method":"GET","url":"/v1/x"}"""),
            "not an absolute URL"
        )
        rejects(request(requestTemplate = """{"method":"GET"}"""), "missing a 'url'")
    }

    @Test
    fun `a placeholder in the scheme or host is rejected`() {
        rejects(
            request(requestTemplate = """{"method":"GET","url":"https://{{args.id}}.example.com/v1/x"}"""),
            "placeholder in its scheme or host"
        )
        rejects(
            request(requestTemplate = """{"method":"GET","url":"https://api.example.com:{{args.id}}/v1/x"}"""),
            "placeholder in its scheme or host"
        )
        // Templating the path is exactly what is allowed.
        CustomerToolValidator.validate(
            request(requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/issues/{{args.id}}"}""")
        )
    }

    @Test
    fun `args placeholders must name a declared property`() {
        rejects(
            request(requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/{{args.unknown}}"}"""),
            "not declared"
        )
        rejects(
            request(
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/x",
                    "headers":{"X-Who":"{{args.unknown}}"}}"""
            ),
            "not declared"
        )
        rejects(
            request(
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/x",
                    "query":{"q":"{{args.unknown}}"}}"""
            ),
            "not declared"
        )
        rejects(
            request(
                requestTemplate = """{"method":"POST","url":"https://api.example.com/v1/x",
                    "body":{"title":"{{args.unknown}}"},"bodyType":"json"}"""
            ),
            "not declared"
        )
    }

    @Test
    fun `only the args and credential namespaces exist`() {
        rejects(
            request(requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/{{env.SECRET}}"}"""),
            "is not valid"
        )
        rejects(
            request(requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/{{id}}"}"""),
            "is not valid"
        )
        // Any credential key is accepted — it resolves from the decrypted blob.
        CustomerToolValidator.validate(
            request(
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/x",
                    "headers":{"Authorization":"Bearer {{credential.anything_at_all}}"}}"""
            )
        )
    }

    @Test
    fun `header and query values must be text`() {
        rejects(
            request(
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/x","query":{"limit":5}}"""
            ),
            "must be a text value"
        )
        rejects(
            request(
                requestTemplate = """{"method":"GET","url":"https://api.example.com/v1/x","headers":[]}"""
            ),
            "must be an object"
        )
    }

    @Test
    fun `body must be an object or null and bodyType is a closed set`() {
        rejects(
            request(requestTemplate = """{"method":"POST","url":"https://api.example.com/v1/x","body":"raw"}"""),
            "must be an object"
        )
        rejects(
            request(
                requestTemplate = """{"method":"POST","url":"https://api.example.com/v1/x",
                    "body":{},"bodyType":"xml"}"""
            ),
            "bodyType"
        )
        CustomerToolValidator.validate(
            request(
                requestTemplate = """{"method":"POST","url":"https://api.example.com/v1/x",
                    "body":{},"bodyType":"form"}"""
            )
        )
    }

    // ── responseTransform ─────────────────────────────────────────────────────

    @Test
    fun `response transform mode is a closed set`() {
        rejects(request(responseTransform = """{"mode":"xml"}"""), "mode 'xml' is not valid")
        rejects(request(responseTransform = """{}"""), "missing a 'mode'")
        rejects(request(responseTransform = """{"mode":"text","strip":true}"""), "unsupported field")
        CustomerToolValidator.validate(request(responseTransform = """{"mode":"json"}"""))
    }

    @Test
    fun `json_path mode requires a path`() {
        rejects(request(responseTransform = """{"mode":"json_path"}"""), "needs a dotted 'path'")
        rejects(request(responseTransform = """{"mode":"json_path","path":"  "}"""), "needs a dotted 'path'")
    }

    @Test
    fun `maxChars is capped at 32000`() {
        rejects(request(responseTransform = """{"mode":"text","maxChars":32001}"""), "between 1 and 32000")
        rejects(request(responseTransform = """{"mode":"text","maxChars":0}"""), "between 1 and 32000")
        rejects(request(responseTransform = """{"mode":"text","maxChars":"8000"}"""), "whole number")
        CustomerToolValidator.validate(request(responseTransform = """{"mode":"text","maxChars":32000}"""))
    }
}
