package com.genflowly.service

import com.genflowly.models.Conversation
import com.genflowly.models.Instruction
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerBlock
import com.genflowly.repository.CustomerBlockRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.PurgeRepository
import com.genflowly.repository.ReceivedShare
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import java.time.Instant
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class BlockServiceTest {
    private val blocks = mockk<CustomerBlockRepository>(relaxed = true)
    private val shares = mockk<ShareRepository>(relaxed = true)
    private val purge = mockk<PurgeRepository>(relaxed = true)
    private val conversations = mockk<ConversationRepository>(relaxed = true)
    private val instructions = mockk<InstructionRepository>(relaxed = true)
    private val profiles = mockk<CustomerProfileRepository>(relaxed = true)
    private val now = Instant.parse("2026-11-08T10:00:00Z")
    private val service = BlockService(blocks, shares, purge, conversations, instructions, profiles) { now }

    private val a = "CU-A"
    private val b = "CU-B"
    private val c = "CU-C"

    private fun stubProfile(id: String, username: String = "user-$id") {
        coEvery { profiles.getCustomerProfileByCustomerId(id) } returns mapOf(
            "username" to AttributeValue.builder().s(username).build(),
            "name" to AttributeValue.builder().s("Name $id").build()
        )
    }

    @Test
    fun `block stores the username at block time`() = runTest {
        stubProfile(b, "mara")
        coEvery { shares.conversationSharesWith(any()) } returns emptyList()
        coEvery { shares.entitySharesWith(any()) } returns emptyList()
        val saved = slot<CustomerBlock>()
        coEvery { blocks.block(capture(saved)) } returns Unit

        service.block(a, b)

        assertEquals(CustomerBlock(a, b, "mara", "Name $b", now.toString()), saved.captured)
    }

    @Test
    fun `block removes what each side shared with the other and nothing else`() = runTest {
        stubProfile(b)
        coEvery { shares.conversationSharesWith(b) } returns listOf(
            ReceivedShare("conv-sharedByA", a),
            ReceivedShare("conv-ownedByA", c),
            ReceivedShare("conv-unrelated", c)
        )
        coEvery { conversations.getConversationById("conv-ownedByA") } returns Conversation(conversationId = "conv-ownedByA", customerId = a, client = "web")
        coEvery { conversations.getConversationById("conv-unrelated") } returns Conversation(conversationId = "conv-unrelated", customerId = c, client = "web")
        coEvery { shares.conversationSharesWith(a) } returns listOf(ReceivedShare("conv-fromB", b))
        coEvery { shares.entitySharesWith(b) } returns listOf(ReceivedShare("INS-ownedByA", c), ReceivedShare("INS-unrelated", c))
        coEvery { shares.entitySharesWith(a) } returns listOf(ReceivedShare("INS-fromB", b))
        coEvery { instructions.getLatestInstructionVersion(any()) } returns 1
        coEvery { instructions.getInstruction("INS-ownedByA", 1) } returns Instruction(id = "INS-ownedByA", creator = a, name = "n", instructions = "t")
        coEvery { instructions.getInstruction("INS-unrelated", 1) } returns Instruction(id = "INS-unrelated", creator = c, name = "n", instructions = "t")

        service.block(a, b)

        coVerify { purge.deleteConversationSharesWith(b, listOf("conv-sharedByA", "conv-ownedByA")) }
        coVerify { purge.deleteConversationSharesWith(a, listOf("conv-fromB")) }
        coVerify { purge.deleteEntitySharesWith(b, listOf("INS-ownedByA")) }
        coVerify { purge.deleteEntitySharesWith(a, listOf("INS-fromB")) }
    }

    @Test
    fun `can't block yourself, PUBLIC or an unknown user`() = runTest {
        assertFailsWith<IllegalArgumentException> { service.block(a, a) }
        assertFailsWith<IllegalArgumentException> { service.block(a, "PUBLIC") }
        coEvery { profiles.getCustomerProfileByCustomerId("nobody") } returns null
        assertFailsWith<BlockTargetNotFoundException> { service.block(a, "nobody") }
        coVerify(exactly = 0) { blocks.block(any()) }
    }

    @Test
    fun `ensureNotBlocked throws for a blocked pair and never for PUBLIC`() = runTest {
        coEvery { blocks.isBlockedEitherWay(a, b) } returns true
        assertFailsWith<UserBlockedException> { service.ensureNotBlocked(a, b) }
        service.ensureNotBlocked(a, "PUBLIC")
        coVerify(exactly = 1) { blocks.isBlockedEitherWay(any(), any()) }
    }

    @Test
    fun `blocked users are listed newest first`() = runTest {
        coEvery { blocks.blocksBy(a) } returns listOf(
            CustomerBlock(a, "old", "old-name", null, "2026-01-01T00:00:00Z"),
            CustomerBlock(a, "new", "new-name", null, "2026-06-01T00:00:00Z")
        )
        assertEquals(listOf("new", "old"), service.blockedUsers(a).map { it.customerId })
    }
}
