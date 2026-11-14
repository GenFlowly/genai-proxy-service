package com.genflowly.service

import com.genflowly.models.Conversation
import com.genflowly.models.CustomerProfile
import com.genflowly.models.Instruction
import com.genflowly.models.Message
import com.genflowly.models.ShareRole
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerBlockRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The filter and block rules at the points where content reaches another user. */
class SharingModerationTest {
    private val owner = "CU-OWNER"
    private val editor = "CU-EDITOR"
    private val target = "CU-TARGET"
    private val conv = "conv-1"
    private val filter = ContentFilter(listOf("badword"))

    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val blockRepo = mockk<CustomerBlockRepository>(relaxed = true)
    private val blockService = mockk<BlockService>(relaxed = true)
    private val conversations = ConversationService(conversationRepo, shareRepo, mockk(relaxed = true), mockk(relaxed = true), blockRepo, filter)
    private val management = ConversationManagementService(
        conversations, conversationRepo, shareRepo, mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), blockService, filter
    )

    private fun message(text: String) = mockk<Message> { every { this@mockk.text } returns text }

    private fun stubConversation(title: String = "Plan", texts: List<String> = listOf("all fine")) {
        coEvery { conversationRepo.getConversationById(conv) } returns Conversation(conversationId = conv, customerId = owner, client = "web")
        coEvery { conversationRepo.isConversationArchived(conv, owner) } returns false
        coEvery { conversationRepo.getConversationTitle(conv, owner) } returns title
        coEvery { conversationRepo.getMessagesForConversation(conv) } returns texts.map(::message)
        coEvery { shareRepo.getConversationShare(conv, any()) } returns null
    }

    @Test
    fun `a clean conversation is shared`() = runTest {
        stubConversation()
        management.shareConversation(conv, target, owner, ShareRole.VIEW)
        coVerify { shareRepo.shareConversationWithCustomer(conv, target, owner, ShareRole.VIEW) }
    }

    @Test
    fun `a listed word in a message or the title refuses the share, public included`() = runTest {
        stubConversation(texts = listOf("fine", "a badword here"))
        assertFailsWith<ContentBlockedException> { management.shareConversation(conv, target, owner, ShareRole.VIEW) }
        assertFailsWith<ContentBlockedException> { management.shareConversation(conv, "PUBLIC", owner, ShareRole.VIEW) }
        stubConversation(title = "badword title")
        assertFailsWith<ContentBlockedException> { management.shareConversation(conv, target, owner, ShareRole.VIEW) }
        coVerify(exactly = 0) { shareRepo.shareConversationWithCustomer(any(), any(), any(), any()) }
    }

    @Test
    fun `changing the role of someone already shared with skips the filter`() = runTest {
        stubConversation(texts = listOf("a badword here"))
        coEvery { shareRepo.getConversationShare(conv, target) } returns ShareRole.VIEW
        management.shareConversation(conv, target, owner, ShareRole.EDIT)
        coVerify { shareRepo.shareConversationWithCustomer(conv, target, owner, ShareRole.EDIT) }
    }

    @Test
    fun `sharing is refused when the sharer or the owner has a block with the target`() = runTest {
        stubConversation()
        coEvery { shareRepo.getConversationShare(conv, editor) } returns ShareRole.EDIT
        coEvery { blockService.ensureNotBlocked(owner, target) } throws UserBlockedException()
        assertFailsWith<UserBlockedException> { management.shareConversation(conv, target, editor, ShareRole.VIEW) }
        coVerify { blockService.ensureNotBlocked(editor, target) }
        coVerify(exactly = 0) { shareRepo.shareConversationWithCustomer(any(), any(), any(), any()) }
    }

    @Test
    fun `a recipient with EDIT can't post a listed word`() = runTest {
        stubConversation()
        coEvery { shareRepo.getConversationShare(conv, editor) } returns ShareRole.EDIT
        assertFailsWith<ContentBlockedException> {
            conversations.resolveWritableConversationId(editor, "web", conv, null, "this badword")
        }
        assertEquals(conv, conversations.resolveWritableConversationId(editor, "web", conv, null, "this is fine"))
    }

    @Test
    fun `the owner's own messages aren't filtered`() = runTest {
        stubConversation()
        assertEquals(conv, conversations.resolveWritableConversationId(owner, "web", conv, null, "this badword"))
    }

    @Test
    fun `a public conversation is denied to a signed-in viewer with a block, and open to anyone else`() = runTest {
        stubConversation()
        val viewer = "CU-VIEWER"
        coEvery { shareRepo.getConversationShare(conv, viewer) } returns null
        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns ShareRole.VIEW
        coEvery { blockRepo.isBlockedEitherWay(viewer, owner) } returns true
        assertNull(conversations.getConversationRole(conv, viewer))

        coEvery { blockRepo.isBlockedEitherWay(viewer, owner) } returns false
        assertEquals(ShareRole.VIEW, conversations.getConversationRole(conv, viewer))

        coEvery { blockRepo.isBlockedEitherWay(any(), any()) } returns true
        assertEquals(ShareRole.VIEW, conversations.getConversationRole(conv, "PUBLIC"))
    }

    private val instructionRepo = mockk<InstructionRepository>(relaxed = true)
    private val resolver = mockk<SharedUsersResolver>(relaxed = true)
    private val instructionService = InstructionService(
        instructionRepo, shareRepo, mockk(relaxed = true), resolver, mockk(relaxed = true), mockk(relaxed = true),
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), blockService, filter
    )
    private val ins = "INS-1"

    private fun stubInstruction(text: String = "be helpful", name: String = "Helper") {
        coEvery { instructionRepo.getLatestInstructionVersion(ins) } returns 1
        coEvery { instructionRepo.getInstruction(ins, 1) } returns Instruction(id = ins, creator = owner, name = name, instructions = text, version = 1)
    }

    @Test
    fun `sharing an instruction with a listed word is refused`() = runTest {
        stubInstruction(text = "a badword")
        coEvery { shareRepo.getSharesForEntity(ins) } returns emptyList()
        assertFailsWith<ContentBlockedException> { instructionService.shareInstruction(ins, target, owner, ShareRole.VIEW) }
        coVerify(exactly = 0) { shareRepo.shareEntityWithCustomer(any(), any(), any(), any()) }
    }

    @Test
    fun `a view-only recipient can take themselves off an instruction but not anyone else`() = runTest {
        stubInstruction()
        coEvery { resolver.getUsersWithSharedEntity(ins) } returns emptyList()
        instructionService.unshareInstruction(ins, editor, editor)
        coVerify { shareRepo.unshareEntityWithCustomer(ins, editor) }
        assertFailsWith<SecurityException> { instructionService.unshareInstruction(ins, target, editor) }
    }

    @Test
    fun `saving a listed word is refused only once the instruction has shares`() = runTest {
        stubInstruction()
        coEvery { shareRepo.getSharesForEntity(ins) } returns listOf(target to ShareRole.VIEW)
        assertFailsWith<ContentBlockedException> {
            instructionService.createInstruction(owner, "Helper", "now a badword", ins)
        }
        coEvery { shareRepo.getSharesForEntity(ins) } returns emptyList()
        assertTrue(instructionService.createInstruction(owner, "Helper", "now a badword", ins).version == 2)
    }

    @Test
    fun `a public instruction from someone with a block is hidden from a signed-in viewer only`() = runTest {
        val viewer = "CU-VIEWER"
        stubInstruction()
        coEvery { instructionRepo.getInstructionsByCreator(any()) } returns emptyList()
        coEvery { shareRepo.getSharedEntityIdsForCustomer(viewer, "INS-") } returns emptyList()
        coEvery { shareRepo.getSharedEntityIdsForCustomer("PUBLIC", "INS-") } returns listOf(ins to ShareRole.VIEW)
        coEvery { blockService.relatedCustomerIds(viewer) } returns setOf(owner)

        assertTrue(instructionService.getCustomerInstructions(viewer).instructions.isEmpty())
        assertEquals(listOf(ins), instructionService.getCustomerInstructions("PUBLIC").instructions.map { it.id })
    }

    @Test
    fun `an instruction's detail is denied to a signed-in viewer with a block`() = runTest {
        val viewer = "CU-VIEWER"
        stubInstruction()
        coEvery { resolver.getUsersWithSharedEntity(ins) } returns listOf(
            CustomerProfile(customerId = "PUBLIC", sub = "", client = "", role = ShareRole.VIEW)
        )
        coEvery { blockService.isBlockedEitherWay(viewer, owner) } returns true
        assertNull(instructionService.getInstructionVersion(viewer, ins, 1))
        assertEquals(ins, instructionService.getInstructionVersion("PUBLIC", ins, 1)?.id)
    }
}
