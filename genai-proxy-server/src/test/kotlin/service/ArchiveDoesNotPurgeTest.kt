package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.Conversation
import com.genflowly.models.ShareRole
import com.genflowly.providers.EncodingPurgeClient
import com.genflowly.providers.RunDataClient
import com.genflowly.providers.RunsClient
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerDataPurgeRepository
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobType
import com.genflowly.repository.ShareRepository
import com.genflowly.testsupport.FakePurgeJobs
import com.genflowly.testsupport.FakeTaggedS3
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Archive stays a restorable soft delete: archive and unarchive delete no S3
 * object and start no purge - except for a conversation whose owner was
 * deleted, which nobody can open once its last share is gone (3.9 step 8).
 */
class ArchiveDoesNotPurgeTest {

    private val owner = "CUOWNER"
    private val editor = "CUEDITOR"
    private val conv = "conv-1"
    private val s3 = FakeTaggedS3()
    private val jobs = FakePurgeJobs()
    private val conversationRepository = mockk<ConversationRepository>(relaxed = true)
    private val shareRepository = mockk<ShareRepository>(relaxed = true)
    private val purgeRepository = mockk<CustomerDataPurgeRepository>(relaxed = true)
    private val purges = ConversationPurgeService(
        conversationRepository, purgeRepository, jobs.repository, s3.provider,
        mockk<RunDataClient>(relaxed = true), mockk<RunsClient>(relaxed = true), mockk<EncodingPurgeClient>(relaxed = true)
    )
    private val conversationService = ConversationService(
        conversationRepository, shareRepository, mockk(relaxed = true), mockk(relaxed = true)
    )
    private val management = ConversationManagementService(
        conversationService, conversationRepository, shareRepository, mockk(relaxed = true), mockk(relaxed = true),
        mockk(relaxed = true), mockk(relaxed = true), AppScope(), purges
    )

    init {
        s3.put("customers/$owner/attachments/a1", "retention" to "kept", "conv" to conv)
        coEvery { conversationRepository.getConversationById(conv) } returns
            Conversation(conversationId = conv, customerId = owner, client = "REACT_APP")
        coEvery { shareRepository.getConversationShare(conv, editor) } returns ShareRole.EDIT
        coEvery { purgeRepository.conversationShareRecipients(conv) } returns emptyList()
    }

    @Test
    fun `archive and unarchive delete nothing and start no purge`() = runTest {
        management.archiveConversation(conv, owner)
        management.unarchiveConversation(conv, owner)
        management.archiveConversation(conv, editor)
        management.unshareConversation(conv, editor, owner)

        assertTrue(jobs.jobs.isEmpty())
        assertEquals(setOf("customers/$owner/attachments/a1"), s3.objects.keys)
        assertTrue(s3.calls.none { it.startsWith("delete") || it.startsWith("putTagging") })
    }

    @Test
    fun `an editor archiving a deleted owner's conversation enqueues its purge`() = runTest {
        jobs.jobs["ACCOUNT#$owner"] = PurgeJob("ACCOUNT#$owner", PurgeJobType.ACCOUNT, owner)

        management.archiveConversation(conv, editor)

        val job = assertNotNull(jobs.jobs[conv])
        assertEquals(PurgeJobType.CONVERSATION, job.type)
        assertEquals(owner, job.customerId)
        // Enqueued only: nothing is deleted until the worker runs the purge
        assertEquals(setOf("customers/$owner/attachments/a1"), s3.objects.keys)
    }

    @Test
    fun `unsharing the last share of a deleted owner's conversation enqueues its purge, not before`() = runTest {
        jobs.jobs["ACCOUNT#$owner"] = PurgeJob("ACCOUNT#$owner", PurgeJobType.ACCOUNT, owner)
        coEvery { purgeRepository.conversationShareRecipients(conv) } returns listOf("PUBLIC")

        management.unshareConversation(conv, "CUSOMEONE", editor)
        assertEquals(setOf("ACCOUNT#$owner"), jobs.jobs.keys)

        coEvery { purgeRepository.conversationShareRecipients(conv) } returns emptyList()
        management.unshareConversation(conv, "PUBLIC", editor)
        assertNotNull(jobs.jobs[conv])
    }
}
