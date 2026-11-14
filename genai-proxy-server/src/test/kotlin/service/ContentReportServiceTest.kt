package com.genflowly.service

import com.genflowly.models.Conversation
import com.genflowly.models.Instruction
import com.genflowly.models.Message
import com.genflowly.models.ShareRole
import com.genflowly.models.api.ContentReportResponse
import com.genflowly.models.api.CreateContentReportRequest
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.api.ReportAction
import com.genflowly.models.api.ReportReason
import com.genflowly.models.api.ReportResolution
import com.genflowly.models.api.ReportStatus
import com.genflowly.models.api.ReportedEntityType
import com.genflowly.models.api.ResolveContentReportRequest
import com.genflowly.providers.SnsNotifier
import com.genflowly.repository.ContentReportRepository
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.PurgeRepository
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import java.time.Instant
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ContentReportServiceTest {
    private val reports = mockk<ContentReportRepository>(relaxed = true)
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val conversations = mockk<ConversationRepository>(relaxed = true)
    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val instructions = mockk<InstructionRepository>(relaxed = true)
    private val profiles = mockk<CustomerProfileRepository>(relaxed = true)
    private val purge = mockk<PurgeRepository>(relaxed = true)
    private val sns = mockk<SnsNotifier>(relaxed = true)
    private val now = Instant.parse("2026-11-08T10:00:00Z")
    private val shares = mockk<ShareRepository>(relaxed = true)
    private val service = ContentReportService(reports, conversationService, conversations, instructionService, instructions, profiles, purge, shares, sns) { now }

    private val owner = "CU-OWNER"
    private val reporter = "CU-REPORTER"
    private val conv = "conv-1"

    private fun message(sequence: Int, role: String, text: String, id: String = "m$sequence") =
        mockk<Message> {
            every { this@mockk.sequence } returns sequence
            every { this@mockk.role } returns role
            every { this@mockk.text } returns text
            every { messageId } returns id
        }

    private fun stubConversation(role: ShareRole?) {
        coEvery { conversationService.getConversationRole(conv, reporter) } returns role
        coEvery { conversations.getConversationById(conv) } returns Conversation(conversationId = conv, customerId = owner, client = "web")
        coEvery { conversations.getConversationTitle(conv, owner) } returns "Launch"
        coEvery { conversations.getMessagesForConversation(conv) } returns listOf(message(1, "user", "hello"), message(2, "assistant", "hi there"))
        coEvery { profiles.getCustomerProfileByCustomerId(owner) } returns mapOf("username" to AttributeValue.builder().s("mara").build())
        coEvery { profiles.getCustomerProfileByCustomerId(reporter) } returns mapOf("username" to AttributeValue.builder().s("devon").build())
    }

    private val request = CreateContentReportRequest(ReportedEntityType.CONVERSATION, conv, reason = ReportReason.HARASSMENT, details = "  rude  ")

    @Test
    fun `a recipient's report stores usernames and a snapshot and emails support`() = runTest {
        stubConversation(ShareRole.VIEW)
        val saved = slot<ContentReportResponse>()
        coEvery { reports.createIfAbsent(capture(saved)) } returns true

        assertTrue(service.createReport(reporter, request))

        with(saved.captured) {
            assertEquals("mara", ownerUsername)
            assertEquals("devon", reporterUsername)
            assertEquals("Launch", title)
            assertEquals("rude", details)
            assertEquals(ReportStatus.OPEN, status)
            assertTrue(contentSnapshot.contains("hi there") && contentSnapshot.contains("hello"))
        }
        coVerify { sns.notifySupport(match { it.contains("conversation") && it.contains("harassment") }, any()) }
    }

    @Test
    fun `a second report keeps the first and sends no email`() = runTest {
        stubConversation(ShareRole.VIEW)
        coEvery { reports.createIfAbsent(any()) } returns false

        assertFalse(service.createReport(reporter, request))

        coVerify(exactly = 0) { sns.notifySupport(any(), any()) }
    }

    @Test
    fun `the owner and strangers can't report`() = runTest {
        stubConversation(ShareRole.OWNER)
        assertFailsWith<ReportNotAllowedException> { service.createReport(reporter, request) }
        stubConversation(null)
        assertFailsWith<ReportNotAllowedException> { service.createReport(reporter, request) }
        coVerify(exactly = 0) { reports.createIfAbsent(any()) }
    }

    @Test
    fun `details over the limit are refused`() = runTest {
        stubConversation(ShareRole.VIEW)
        assertFailsWith<IllegalArgumentException> {
            service.createReport(reporter, request.copy(details = "x".repeat(1001)))
        }
    }

    @Test
    fun `a failed email doesn't lose the report`() = runTest {
        stubConversation(ShareRole.VIEW)
        coEvery { reports.createIfAbsent(any()) } returns true
        coEvery { sns.notifySupport(any(), any()) } throws RuntimeException("sns down")

        assertTrue(service.createReport(reporter, request))
    }

    @Test
    fun `an instruction reports its name and text`() = runTest {
        val id = "INS-1"
        coEvery { instructions.getLatestInstructionVersion(id) } returns 2
        coEvery { instructionService.getInstructionVersion(reporter, id, 2) } returns
            InstructionResponse(id = id, version = 2, name = "n", instruction = "t", role = ShareRole.VIEW)
        coEvery { instructions.getInstruction(id, 2) } returns Instruction(id = id, creator = owner, name = "Persona", instructions = "Be rude")
        val saved = slot<ContentReportResponse>()
        coEvery { reports.createIfAbsent(capture(saved)) } returns true

        service.createReport(reporter, CreateContentReportRequest(ReportedEntityType.INSTRUCTION, id, reason = ReportReason.SPAM))

        assertEquals("Persona", saved.captured.title)
        assertEquals("Be rude", saved.captured.contentSnapshot)
        assertEquals(owner, saved.captured.ownerCustomerId)
    }

    private fun openReport(type: ReportedEntityType = ReportedEntityType.CONVERSATION) = ContentReportResponse(
        entityId = conv, entityType = type, reporterCustomerId = reporter, reason = ReportReason.SPAM,
        contentSnapshot = "s", status = ReportStatus.OPEN, createdAt = now.toString()
    )

    @Test
    fun `dismiss leaves the shares alone`() = runTest {
        coEvery { reports.get(conv, reporter) } returns openReport()
        coEvery { reports.resolveIfOpen(any(), any(), any(), any(), any(), any()) } returns true

        service.resolveReport("admin", conv, reporter, ResolveContentReportRequest(ReportAction.DISMISS, " no issue "))

        coVerify { reports.resolveIfOpen(conv, reporter, ReportResolution.DISMISSED, "no issue", "admin", now.toString()) }
        coVerify(exactly = 0) { purge.deleteConversationShares(any()) }
    }

    @Test
    fun `make private removes every share and resolves every report on the item`() = runTest {
        coEvery { reports.get(conv, reporter) } returns openReport()
        coEvery { reports.reporterIdsFor(conv) } returns listOf(reporter, "CU-OTHER")

        service.resolveReport("admin", conv, reporter, ResolveContentReportRequest(ReportAction.MAKE_PRIVATE))

        coVerify { purge.deleteConversationShares(conv) }
        coVerify { reports.resolveIfOpen(conv, reporter, ReportResolution.MADE_PRIVATE, null, "admin", now.toString()) }
        coVerify { reports.resolveIfOpen(conv, "CU-OTHER", ReportResolution.MADE_PRIVATE, null, "admin", now.toString()) }
    }

    @Test
    fun `make private on an instruction removes its entity shares`() = runTest {
        coEvery { reports.get(conv, reporter) } returns openReport(ReportedEntityType.INSTRUCTION)
        service.resolveReport("admin", conv, reporter, ResolveContentReportRequest(ReportAction.MAKE_PRIVATE))
        coVerify { purge.deleteEntityShares(conv) }
    }

    @Test
    fun `acting on a missing or resolved report fails`() = runTest {
        coEvery { reports.get(conv, reporter) } returns null
        assertFailsWith<ReportNotFoundException> {
            service.resolveReport("admin", conv, reporter, ResolveContentReportRequest(ReportAction.RESOLVE))
        }
        coEvery { reports.get(conv, reporter) } returns openReport()
        coEvery { reports.resolveIfOpen(any(), any(), any(), any(), any(), any()) } returns false
        assertFailsWith<ReportAlreadyResolvedException> {
            service.resolveReport("admin", conv, reporter, ResolveContentReportRequest(ReportAction.RESOLVE))
        }
    }

    @Test
    fun `the owner lookup names the owner for a recipient`() = runTest {
        stubConversation(ShareRole.VIEW)
        coEvery { reports.exists(conv, reporter) } returns true
        coEvery { shares.getConversationShare(conv, reporter) } returns ShareRole.VIEW
        val response = service.ownerOfSharedItem(reporter, ReportedEntityType.CONVERSATION, conv)
        assertTrue(response.canRemove)
        assertEquals(owner, response.ownerCustomerId)
        assertEquals("mara", response.ownerUsername)
        assertTrue(response.canBlock)
        assertTrue(response.alreadyReported)
    }

    @Test
    fun `an item with no person behind it can be reported but not blocked`() = runTest {
        stubConversation(ShareRole.VIEW)
        coEvery { profiles.getCustomerProfileByCustomerId(owner) } returns null
        coEvery { shares.getConversationShare(conv, reporter) } returns null
        val response = service.ownerOfSharedItem(reporter, ReportedEntityType.CONVERSATION, conv)
        assertFalse(response.canBlock)
        assertFalse(response.canRemove)
    }
}
