package com.genflowly.service

import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.models.AttachmentObjectInfo
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.models.api.NewAgentNode
import com.genflowly.providers.S3Provider
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * PDF letterhead logos (plan 6.2): admins upload System agents' logos under
 * System's attachments, untagged; a saved logo id must name a file generate_pdf
 * can read (the graph owner's, or System's), never another customer's.
 */
class LetterheadLogoServiceTest {

    private val stored = mutableSetOf<String>()
    private val s3Provider = mockk<S3Provider> {
        coEvery { presignPut(any(), any(), any()) } answers { "https://s3.example/${firstArg<String>()}?sig" }
        coEvery { presignGet(any(), any()) } answers { "https://s3.example/${firstArg<String>()}?get" }
        coEvery { head(any()) } answers {
            if (firstArg<String>() in stored) AttachmentObjectInfo(sizeBytes = 10, contentType = "image/png") else null
        }
    }
    private val logos = LetterheadLogoService(s3Provider)

    @Test
    fun `an admin upload is presigned under System's attachments, untagged`() = runTest {
        val upload = logos.createUpload("IMAGE/PNG; x=y", 1024)

        assertEquals("image/png", upload.mediaType)
        coVerify(exactly = 1) {
            s3Provider.presignPut("customers/$SYSTEM_GRAPH_OWNER/attachments/${upload.attachmentId}", "image/png", null)
        }
    }

    @Test
    fun `only a PNG or JPEG of at most 2 MB is accepted`() = runTest {
        assertFailsWith<IllegalArgumentException> { logos.createUpload("image/svg+xml", 10) }
        assertFailsWith<IllegalArgumentException> { logos.createUpload(null, 10) }
        assertFailsWith<IllegalArgumentException> { logos.createUpload("image/jpeg", 2L * 1024 * 1024 + 1) }
        assertFailsWith<IllegalArgumentException> { logos.createUpload("image/jpeg", 0) }
        logos.createUpload("image/jpeg", 2L * 1024 * 1024)
    }

    @Test
    fun `the preview resolves System's logos only`() = runTest {
        stored += "customers/$SYSTEM_GRAPH_OWNER/attachments/logo-0001"
        stored += "customers/cust-2/attachments/logo-0002"

        assertEquals("https://s3.example/customers/$SYSTEM_GRAPH_OWNER/attachments/logo-0001?get", logos.viewUrl("logo-0001"))
        assertNull(logos.viewUrl("logo-0002"))
        assertNull(logos.viewUrl("../cust-2/attachments/logo-0002"))
    }

    @Test
    fun `a logo exists for the graph owner's files and System's, never another customer's`() = runTest {
        stored += "customers/cust-1/attachments/own-logo-1"
        stored += "customers/$SYSTEM_GRAPH_OWNER/attachments/sys-logo-1"
        stored += "customers/cust-2/attachments/other-logo"

        assertTrue(logos.exists("cust-1", "own-logo-1"))
        assertTrue(logos.exists("cust-1", "sys-logo-1"))
        assertTrue(logos.exists(SYSTEM_GRAPH_OWNER, "sys-logo-1"))
        assertFalse(logos.exists("cust-1", "other-logo"))
        assertFalse(logos.exists("cust-1", "../cust-2/attachments/other-logo"))
    }

    // ── Save-time check in GraphService ──────────────────────────────────────

    private val graphRepo = mockk<GraphRepository>(relaxed = true)
    private val graphService = GraphService(
        graphRepo, mockk<InstructionRepository>(relaxed = true), mockk<RequestAgentMapRepository>(relaxed = true),
        logos,
    )

    private fun agentWithLogo(logoId: String) = CreateGraphAgentRequest(
        name = "Reports",
        maxIterations = 10,
        entryPoint = "tools",
        edges = """{"edges":[{"from":"tools","to":"__end__"}]}""",
        nodes = listOf(
            NewAgentNode(
                tempId = "tools", nodeType = "TOOL_EXECUTOR", name = "Tools",
                config = """{"tools":["generate_pdf"],"tool_settings":{"generate_pdf":""" +
                    """{"company_name":"Acme","logo_attachment_id":"$logoId"}}}""",
            ),
        ),
    )

    private fun readBackWrites() {
        var written: Map<String, AttributeValue>? = null
        coEvery {
            graphRepo.createCustomerGraph(
                customerId = any(), graphId = any(), name = any(), isDefault = any(),
                nodeIds = any(), edges = any(), entryPoint = any(), maxIterations = any(), layout = anyNullable(),
            )
        } answers {
            written = mapOf(
                "customerId" to AttributeValue.builder().s(arg<String>(0)).build(),
                "graphId" to AttributeValue.builder().s(arg<String>(1)).build(),
                "name" to AttributeValue.builder().s(arg<String>(2)).build(),
                "isDefault" to AttributeValue.builder().bool(arg<Boolean>(3)).build(),
                "nodeIds" to AttributeValue.builder().l(arg<List<String>>(4).map { AttributeValue.builder().s(it).build() }).build(),
                "edges" to AttributeValue.builder().s(arg<String>(5)).build(),
                "entryPoint" to AttributeValue.builder().s(arg<String>(6)).build(),
                "maxIterations" to AttributeValue.builder().n(arg<Int>(7).toString()).build(),
            )
        }
        coEvery { graphRepo.getCustomerGraph(any()) } answers { written }
    }

    @Test
    fun `an agent naming its owner's or System's logo is saved`() = runTest {
        readBackWrites()
        stored += "customers/cust-1/attachments/own-logo-1"
        stored += "customers/$SYSTEM_GRAPH_OWNER/attachments/sys-logo-1"

        graphService.createGraphAgent("cust-1", agentWithLogo("own-logo-1"))
        graphService.createGraphAgent("cust-1", agentWithLogo("sys-logo-1"))

        coVerify(exactly = 2) { graphRepo.createCustomerGraphNode("cust-1", any(), "TOOL_EXECUTOR", any(), any()) }
    }

    @Test
    fun `an agent naming another customer's file is refused before anything is written`() = runTest {
        stored += "customers/cust-2/attachments/other-logo"

        val e = assertFailsWith<IllegalArgumentException> {
            graphService.createGraphAgent("cust-1", agentWithLogo("other-logo"))
        }
        assertTrue(e.message!!.contains("letterhead logo"))
        coVerify(exactly = 0) { graphRepo.createCustomerGraphNode(any(), any(), any(), any(), any()) }
    }
}
