package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Conversation
import com.genflowly.models.Message
import com.genflowly.models.ShareRole
import com.genflowly.providers.Auth0ManagementClient
import com.genflowly.providers.CustomerDocumentsPurger
import com.genflowly.providers.EncodingPurgeClient
import com.genflowly.providers.RunDataClient
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerDataPurgeRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MessageFileRefs
import com.genflowly.repository.MessageKey
import com.genflowly.repository.PurgeJobState
import com.genflowly.repository.PurgeJobType
import com.genflowly.repository.ShareRepository
import com.genflowly.testsupport.FakeProfileTables
import com.genflowly.testsupport.FakePurgeJobs
import com.genflowly.testsupport.FakeTaggedS3
import com.genflowly.testsupport.testAppConfig
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Customer deletion (plan 3.9) end to end over in-memory profile, job and S3
 * stores: the profile is renamed and re-keyed, shared conversations and the
 * customer's messages in other people's conversations are kept (and show
 * "Deleted User"), unshared and archived conversations get purge jobs, the
 * backstop sweep spares exactly the keep set, and the rest goes.
 */
class AccountDeletionTest {

    private val deleted = "CUDEL"
    private val recipient = "CUREC"
    private val otherOwner = "CUOTH"
    private val oldSub = "auth0|dana"
    private val appConfig = testAppConfig().copy(reactAppAuth0ClientIds = setOf("spa-client"))

    private val profiles = FakeProfileTables().apply {
        addProfile(oldSub, "REACT_APP", deleted, "Dana Deleted", "dana-1a2b3c")
        addProfile("auth0|rita", "REACT_APP", recipient, "Rita Recipient", "rita-000001")
        addProfile("auth0|oscar", "REACT_APP", otherOwner, "Oscar Owner", "oscar-000001")
    }
    private val profileRepository = CustomerProfileRepository(profiles.client, mockk<KLogger>(relaxed = true))
    private val profileService = CustomerProfileService(profileRepository, mockk(relaxed = true), mockk(relaxed = true), appConfig)

    private val jobs = FakePurgeJobs()
    private val s3 = FakeTaggedS3()
    private val conversations = mockk<ConversationRepository>()
    private val purge = mockk<CustomerDataPurgeRepository>(relaxed = true)
    private val runData = mockk<RunDataClient>(relaxed = true)
    private val encoding = mockk<EncodingPurgeClient>(relaxed = true)
    private val documents = mockk<CustomerDocumentsPurger>(relaxed = true)
    private val auth0 = mockk<Auth0ManagementClient>()
    private val cancelledFor = mutableListOf<String>()
    private val turns = object : InFlightTurns {
        override suspend fun cancelAndAwait(customerId: String, timeoutMs: Long): Int {
            cancelledFor += customerId
            return 1
        }
    }
    private val orphans = mockk<OrphanedConversationPurge>(relaxed = true)
    private val service = AccountDeletionService(
        jobs.repository, profileService, profileRepository, conversations, purge, s3.provider,
        runData, encoding, documents, auth0, turns, orphans
    )

    private fun key(customer: String, id: String) = "customers/$customer/attachments/$id"

    private fun refs(conv: String, id: String, author: String, role: String, vararg attachments: AttachmentRef, runId: String? = null) =
        MessageFileRefs(conv, id, author, role, attachments.toList(), null, null, runId, false, null)

    private val shares = mapOf(
        "conv-shared" to listOf(recipient),
        "conv-public" to listOf("PUBLIC"),
        "conv-unshared" to emptyList(),
        "conv-archived" to emptyList(), // archive deleted its shares
        "conv-other" to listOf(deleted, "PUBLIC")
    )

    private val sharedMessages = listOf(
        refs("conv-shared", "s1", deleted, "user", AttachmentRef("img1", key(deleted, "img1"), "image/png")),
        refs(
            "conv-shared", "s2", deleted, "assistant",
            AttachmentRef("pdf1", key(deleted, "pdf1"), "application/pdf", sourceKey = key(deleted, "pdf1") + ".source.md"),
            runId = "run_s2"
        ),
        refs("conv-shared", "s3", recipient, "user", AttachmentRef("r1", key(recipient, "r1"), "image/png"))
    )
    private val publicMessages = listOf(
        refs("conv-public", "p1", deleted, "user", AttachmentRef("imgp", key(deleted, "imgp"), "image/png"))
    )
    private val otherMessage =
        refs("conv-other", "o1", deleted, "user", AttachmentRef("img2", key(deleted, "img2"), "image/png"), runId = "run_o1")

    init {
        for ((conv, recipients) in shares) coEvery { purge.conversationShareRecipients(conv) } returns recipients
        coEvery { purge.recipientConversationIds(deleted) } returns listOf("conv-other")
        coEvery { purge.instructionIdsByCreator(deleted) } returns setOf("INSD1", "INSSYS")
        coEvery { purge.ownedGraphIds(deleted) } returns setOf("GRPD1")
        coEvery { purge.ownedNodeIds(deleted) } returns setOf("NODD1")
        coEvery { purge.deleteDeveloperApiKeys(deleted) } returns 2
        // Node configs reference instructions in snake_case, as the retrieval server reads them
        coEvery { purge.nodeConfigs("System") } returns listOf(
            """{"instruction_id":"INSSYS","input_template":"{input}","output_format":"text"}"""
        )

        coEvery { conversations.getOwnedConversationIds(deleted) } returns
            listOf("conv-shared", "conv-public", "conv-unshared", "conv-archived")
        coEvery { conversations.getMessageFileRefs("conv-shared") } returns sharedMessages
        coEvery { conversations.getMessageFileRefs("conv-public") } returns publicMessages
        coEvery { conversations.getMessageKeysByCustomer(deleted) } returns listOf(
            MessageKey("conv-shared", "s1"), MessageKey("conv-shared", "s2"), MessageKey("conv-public", "p1"),
            MessageKey("conv-unshared", "u1"), MessageKey("conv-other", "o1")
        )
        coEvery { conversations.getMessageFileRefs(any(), any()) } answers {
            (sharedMessages + publicMessages + otherMessage).firstOrNull { it.messageId == secondArg<String>() }
        }
        coEvery { conversations.getConversationById("conv-other") } returns
            Conversation(conversationId = "conv-other", customerId = otherOwner, client = "REACT_APP")

        coEvery { auth0.deleteUser(oldSub) } returns Auth0ManagementClient.DeleteResult.DELETED
        coEvery { encoding.isConfigured } returns true
        coEvery { documents.purgeCustomer(deleted) } returns 3

        for (id in listOf("img1", "pdf1", "imgp", "img2")) s3.put(key(deleted, id), "retention" to "kept")
        s3.put(key(deleted, "pdf1") + ".source.md", "retention" to "kept")
        s3.put(key(deleted, "pdf1") + ".derived/text-v1.json", "retention" to "derived")
        s3.put(key(deleted, "u1"), "retention" to "kept")
        s3.put(key(deleted, "unsent"), "retention" to "pending")
        s3.put("customers/$deleted/agent-fs/ns-12345678/scratch.md", "retention" to "scratch")
        s3.put(key(recipient, "r1"), "retention" to "kept")
        s3.put(key("CUDEL2", "x"), "retention" to "pending") // a customer id with this one as prefix
    }

    private suspend fun deleteAndRunOnce(): PurgeOutcome {
        service.requestDeletion(deleted, "admin-1")
        return service.run(jobs.jobs["ACCOUNT#$deleted"]!!)
    }

    @Test
    fun `the profile is renamed, keeps its username, and no longer resolves from the old login`() = runTest {
        deleteAndRunOnce()

        val profile = assertNotNull(profileRepository.getCustomerProfileByCustomerId(deleted))
        assertEquals("Deleted User", profile["name"]?.s())
        assertEquals("dana-1a2b3c", profile["username"]?.s())
        assertEquals("DELETED#$deleted", profile["sub"]?.s())
        // Reading it again mints nothing and reserves nothing
        profileRepository.getCustomerProfileByCustomerId(deleted)
        assertTrue(profiles.usernameWrites.isEmpty())
        assertNull(profiles.usernames["dana-1a2b3c"])
        assertNull(profileService.getCustomerIdForToken(oldSub, "spa-client"))
        assertNull(profileService.getCustomerIdForToken(oldSub, null))
        // Other customers are untouched
        assertEquals(recipient, profileService.getCustomerIdForToken("auth0|rita", "spa-client"))
    }

    @Test
    fun `writes stop before the rename, and in-flight turns end before anything is classified`() = runTest {
        deleteAndRunOnce()

        coVerifyOrder {
            purge.deleteDeveloperApiKeys(deleted)
            auth0.deleteUser(oldSub)
            conversations.getOwnedConversationIds(deleted)
        }
        assertEquals(listOf(deleted), cancelledFor)
        coVerifyOrder {
            auth0.deleteUser(oldSub)
            conversations.getOwnedConversationIds(deleted)
            conversations.getMessageKeysByCustomer(deleted)
            s3.provider.listKeys("customers/$deleted/")
        }
    }

    @Test
    fun `shared conversations are kept and the unshared and archived ones get purge jobs`() = runTest {
        val outcome = deleteAndRunOnce()

        assertEquals(setOf("conv-unshared", "conv-archived"), jobs.jobs["ACCOUNT#$deleted"]!!.childKeys)
        for (conv in listOf("conv-unshared", "conv-archived")) {
            val job = assertNotNull(jobs.jobs[conv])
            assertEquals(PurgeJobType.CONVERSATION, job.type)
            assertEquals(deleted, job.customerId)
        }
        for (conv in listOf("conv-shared", "conv-public")) assertNull(jobs.jobs[conv])
        // The account job never deletes a Conversation row itself: kept ones stay for their recipients
        coVerify(exactly = 0) { purge.deleteConversationRow(any(), any()) }
        // It waits for its conversation purges before it is done
        assertIs<PurgeOutcome.Reschedule>(outcome)
    }

    @Test
    fun `the backstop sweep deletes scratch, unsent uploads and purged conversations' objects, and spares the keep set`() = runTest {
        deleteAndRunOnce()

        val survivors = s3.objects.keys
        for (kept in listOf(
            key(deleted, "img1"), key(deleted, "pdf1"), key(deleted, "pdf1") + ".source.md",
            key(deleted, "pdf1") + ".derived/text-v1.json", key(deleted, "imgp"), key(deleted, "img2")
        )) assertTrue(kept in survivors, "$kept must be kept")
        for (gone in listOf(
            key(deleted, "unsent"), "customers/$deleted/agent-fs/ns-12345678/scratch.md", key(deleted, "u1")
        )) assertTrue(gone !in survivors, "$gone must be deleted")
        // Other customers' objects are never listed or touched
        assertTrue(key(recipient, "r1") in survivors)
        assertTrue(key("CUDEL2", "x") in survivors)
    }

    @Test
    fun `everything else the customer owns is deleted, with the run data of their kept messages`() = runTest {
        deleteAndRunOnce()

        coVerify { runData.deleteRunData("run_s2") }
        coVerify { runData.deleteRunData("run_o1") }
        // ...and every other run of the customer the retrieval-server finds by its input
        coVerify(exactly = 1) { runData.deleteCustomerRunData(deleted) }
        coVerify { purge.deleteConversationShare(deleted, "conv-other") }
        coVerify { orphans.enqueueIfOrphaned("conv-other", otherOwner) }
        coVerify { purge.deleteEntityShares(setOf("INSD1", "GRPD1")) }
        coVerify { purge.deleteAllVersions(CustomerDataPurgeRepository.INSTRUCTION_VERSIONS, "INSD1") }
        coVerify(exactly = 0) { purge.deleteAllVersions(CustomerDataPurgeRepository.INSTRUCTION_VERSIONS, "INSSYS") }
        coVerify { purge.deleteAllVersions(CustomerDataPurgeRepository.GRAPH_VERSIONS, "GRPD1") }
        coVerify { purge.deleteAllVersions(CustomerDataPurgeRepository.NODE_VERSIONS, "NODD1") }
        coVerify { purge.deletePartition(CustomerDataPurgeRepository.REQUEST_AGENT_MAP, deleted) }
        for (table in CustomerDataPurgeRepository.CUSTOMER_PARTITION_TABLES) {
            coVerify { purge.deletePartition(table, deleted) }
        }
        coVerifyOrder {
            encoding.dropCustomerCollections(deleted)
            purge.deletePartition(CustomerDataPurgeRepository.VECTOR_DB_CONFIG, deleted)
        }
        coVerify { documents.purgeCustomer(deleted) }
        assertTrue(jobs.jobs["ACCOUNT#$deleted"]!!.warnings.any { it.startsWith("instructions_kept") })
    }

    @Test
    fun `instructions a System agent references are kept, as persona, harness or subagent instruction`() = runTest {
        coEvery { purge.instructionIdsByCreator(deleted) } returns setOf("I1", "H1", "S1", "INSD1", "INSD2")
        coEvery { purge.nodeConfigs("System") } returns listOf(
            """{"instruction_id":"I1","harness_instruction_id":"H1"}""",
            // a TOOL_EXECUTOR config: subagent profiles carry their own instruction
            """{"subagents":[{"name":"researcher","instruction_id":"S1","instruction_version":2}]}""",
            // blank or null references protect nothing, and a broken config is skipped
            """{"instruction_id":"","harness_instruction_id":null}""",
            "not json"
        )

        deleteAndRunOnce()

        for (id in listOf("I1", "H1", "S1")) {
            coVerify(exactly = 0) { purge.deleteAllVersions(CustomerDataPurgeRepository.INSTRUCTION_VERSIONS, id) }
        }
        for (id in listOf("INSD1", "INSD2")) {
            coVerify { purge.deleteAllVersions(CustomerDataPurgeRepository.INSTRUCTION_VERSIONS, id) }
        }
        // Shares of the kept instructions stay too; the agents' graph goes
        coVerify { purge.deleteEntityShares(setOf("INSD1", "INSD2", "GRPD1")) }
        assertTrue("instructions_kept: 3 instruction(s) are used by System agents" in jobs.jobs["ACCOUNT#$deleted"]!!.warnings)
    }

    @Test
    fun `no instruction is deleted when the System agents cannot be read`() = runTest {
        coEvery { purge.nodeConfigs("System") } throws IllegalStateException("throttled")

        assertFailsWith<IllegalStateException> { deleteAndRunOnce() }

        coVerify(exactly = 0) { purge.deleteAllVersions(CustomerDataPurgeRepository.INSTRUCTION_VERSIONS, any()) }
        coVerify(exactly = 0) { purge.deleteEntityShares(any()) }
        // The job stays at the last completed stage, so the worker's retry redoes this one
        assertEquals(AccountDeletionService.STAGE_SWEPT, jobs.jobs["ACCOUNT#$deleted"]!!.stage)
    }

    @Test
    fun `instruction references are found at any depth of a node config`() {
        val config = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"instruction_id":"A","tools":[{"subagents":[{"harness_instruction_id":"B","subagents":[{"instruction_id":"C"}]}]}],
               "instruction_version":3,"other":{"instruction_id":7},"instructionId":"camel-is-not-read"}"""
        )
        assertEquals(setOf("A", "B", "C", "7"), AccountDeletionService.instructionRefs(config).toSet())
    }

    @Test
    fun `the job resumes after its last completed step and finishes once its conversation purges are done`() = runTest {
        assertIs<PurgeOutcome.Reschedule>(deleteAndRunOnce())
        assertEquals(AccountDeletionService.STAGE_ROWS_DELETED, jobs.jobs["ACCOUNT#$deleted"]!!.stage)

        for (conv in listOf("conv-unshared", "conv-archived")) {
            jobs.jobs[conv] = jobs.jobs[conv]!!.copy(state = PurgeJobState.DONE)
        }
        assertIs<PurgeOutcome.Done>(service.run(jobs.jobs["ACCOUNT#$deleted"]!!))

        // Nothing ran twice
        coVerify(exactly = 1) { purge.deleteDeveloperApiKeys(deleted) }
        coVerify(exactly = 1) { auth0.deleteUser(oldSub) }
        coVerify(exactly = 1) { documents.purgeCustomer(deleted) }
    }

    @Test
    fun `a shared conversation the customer owned still loads for its recipient, showing Deleted User`() = runTest {
        deleteAndRunOnce()
        val history = historyFor("conv-shared", owner = deleted, reader = recipient, role = ShareRole.EDIT)

        val senders = history.promptAndResponseList.map { it.sender?.customerId to it.sender?.name }
        assertEquals(listOf(deleted to "Deleted User", recipient to "Rita Recipient"), senders)
    }

    @Test
    fun `the customer's messages in another owner's conversation show Deleted User`() = runTest {
        deleteAndRunOnce()
        val history = historyFor("conv-other", owner = otherOwner, reader = otherOwner, role = null)

        assertEquals(deleted to "Deleted User", history.promptAndResponseList.map { it.sender?.customerId to it.sender?.name }.first())
    }

    private suspend fun historyFor(conv: String, owner: String, reader: String, role: ShareRole?): com.genflowly.models.api.GetConversationResponse {
        fun msg(id: String, author: String, roleName: String, previous: String?, seq: Int) = Message(
            messageId = id, conversationId = conv, text = "text of $id", client = "REACT_APP", role = roleName,
            customerId = author, sequence = seq, systemPrompt = "", aiConfig = listOf(AIConfig(AIVendor.CLAUDE, "m")),
            previousMessageId = previous
        )
        val repo = mockk<ConversationRepository>()
        coEvery { repo.getConversationById(conv) } returns Conversation(conversationId = conv, customerId = owner, client = "REACT_APP")
        coEvery { repo.getMessagesForConversation(conv) } returns listOf(
            msg("a", deleted, "user", null, 1), msg("b", deleted, "assistant", "a", 2),
            msg("c", if (owner == deleted) recipient else otherOwner, "user", "b", 3)
        )
        coEvery { repo.getConversationTitle(conv, owner) } returns "title"
        coEvery { repo.getPendingRuns(owner, conv) } returns emptyList()
        val shareRepo = mockk<ShareRepository>()
        coEvery { shareRepo.getConversationShare(conv, any()) } returns role
        return ConversationService(repo, shareRepo, profileRepository, mockk(relaxed = true)).getConversationHistory(conv, reader)
    }

    @Test
    fun `without the Auth0 Management API the user is kept and a warning recorded`() = runTest {
        coEvery { auth0.deleteUser(oldSub) } returns Auth0ManagementClient.DeleteResult.NOT_CONFIGURED

        deleteAndRunOnce()

        assertTrue(jobs.jobs["ACCOUNT#$deleted"]!!.warnings.any { it.startsWith("auth0_not_configured") })
        // The deletion still went through
        assertEquals("Deleted User", profileRepository.getCustomerProfileByCustomerId(deleted)?.get("name")?.s())
    }

    @Test
    fun `a login that also holds another account is not removed from Auth0`() = runTest {
        profiles.addProfile(oldSub, "ADMIN_PANEL", "CUADMIN", "Dana Admin", "dana-admin")

        deleteAndRunOnce()

        coVerify(exactly = 0) { auth0.deleteUser(any()) }
        assertTrue(jobs.jobs["ACCOUNT#$deleted"]!!.warnings.any { it.startsWith("auth0_user_kept") })
    }

    @Test
    fun `a deletion request is idempotent and refuses reserved ids and self-deletion`() = runTest {
        assertTrue(service.requestDeletion(deleted, "admin-1").created)
        assertEquals(false, service.requestDeletion(deleted, "admin-1").created)
        assertEquals(oldSub, jobs.jobs["ACCOUNT#$deleted"]!!.authSub)

        assertFailsWith<IllegalArgumentException> { service.requestDeletion("System", "admin-1") }
        assertFailsWith<IllegalArgumentException> { service.requestDeletion("admin-1", "admin-1") }
        assertFailsWith<CustomerNotFoundException> { service.requestDeletion("CUNOBODY", "admin-1") }
    }

    @Test
    fun `a renamed profile without a username never mints one on read`() = runTest {
        profiles.addProfile("auth0|legacy", "REACT_APP", "CULEGACY", "Old Timer", username = null)
        service.requestDeletion("CULEGACY", "admin-1")
        coEvery { auth0.deleteUser("auth0|legacy") } returns Auth0ManagementClient.DeleteResult.DELETED
        coEvery { purge.deleteDeveloperApiKeys(any()) } returns 0
        coEvery { conversations.getOwnedConversationIds("CULEGACY") } returns emptyList()
        coEvery { conversations.getMessageKeysByCustomer("CULEGACY") } returns emptyList()
        coEvery { purge.recipientConversationIds("CULEGACY") } returns emptyList()
        coEvery { purge.instructionIdsByCreator("CULEGACY") } returns emptySet()
        coEvery { purge.ownedGraphIds("CULEGACY") } returns emptySet()
        coEvery { purge.ownedNodeIds("CULEGACY") } returns emptySet()
        coEvery { documents.purgeCustomer("CULEGACY") } returns 0

        assertIs<PurgeOutcome.Done>(service.run(jobs.jobs["ACCOUNT#CULEGACY"]!!))
        repeat(2) { profileRepository.getCustomerProfileByCustomerId("CULEGACY") }

        assertTrue(profiles.usernameWrites.isEmpty())
        assertEquals("Deleted User", profileRepository.getCustomerProfileByCustomerId("CULEGACY")?.get("name")?.s())
    }
}
