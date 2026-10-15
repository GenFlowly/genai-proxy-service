package com.genflowly.service

import com.genflowly.models.AttachmentRef
import com.genflowly.providers.EncodingPurgeClient
import com.genflowly.providers.RunDataClient
import com.genflowly.providers.RunsClient
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerDataPurgeRepository
import com.genflowly.repository.PendingRun
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobType
import com.genflowly.testsupport.FakeTaggedS3
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The conversation purge (plan 3.9): reads every message page, deletes every
 * linked object (recipients' included) and nothing else, S3 and run data
 * before rows with the Conversation row last, re-runs cleanly after a crash,
 * and waits for a live durable run without deleting anything.
 */
class ConversationPurgeServiceTest {

    private val owner = "CUOWNER"
    private val recipient = "CURECIP"
    private val conv = "conv-1"
    private val s3 = FakeTaggedS3()
    private val dynamo = mockk<DynamoDbClient>()
    private val conversationRepository = ConversationRepository(dynamo, mockk<KLogger>(relaxed = true))
    private val purgeRepository = mockk<CustomerDataPurgeRepository>(relaxed = true)
    private val jobs = mockk<PurgeJobRepository>(relaxed = true)
    private val runData = mockk<RunDataClient>(relaxed = true)
    private val runs = mockk<RunsClient>(relaxed = true)
    private val encoding = mockk<EncodingPurgeClient>(relaxed = true)
    private val service = ConversationPurgeService(
        conversationRepository, purgeRepository, jobs, s3.provider, runData, runs, encoding
    )
    private val job = PurgeJob(jobKey = conv, type = PurgeJobType.CONVERSATION, customerId = owner, conversationId = conv)
    private val messageQueries = mutableListOf<QueryRequest>()

    private fun s(v: String) = AttributeValue.builder().s(v).build()
    private fun key(customer: String, id: String) = "customers/$customer/attachments/$id"

    private fun attachments(vararg refs: AttributeValue) = AttributeValue.builder().l(*refs).build()
    private fun ref(id: String, s3Key: String, sourceKey: String? = null) = AttributeValue.builder().m(
        buildMap {
            put("attachmentId", s(id)); put("s3Key", s(s3Key)); put("mediaType", s("application/pdf"))
            sourceKey?.let { put("sourceKey", s(it)) }
        }
    ).build()

    private fun row(id: String, author: String, role: String, extra: Map<String, AttributeValue>) =
        mapOf("conversationId" to s(conv), "messageId" to s(id), "customerId" to s(author), "role" to s(role)) + extra

    /** Three Query pages: an owner upload; a recipient PDF with source and scratch; a tool-result image and a malformed key. */
    private val pages = listOf(
        listOf(row("m1", owner, "user", mapOf("attachments" to attachments(ref("img-o", key(owner, "img-o")))))),
        listOf(row("m2", recipient, "assistant", mapOf(
            "attachments" to attachments(ref("pdf-r", key(recipient, "pdf-r"), key(recipient, "pdf-r") + ".source.md")),
            "fsNamespace" to s("ns-abcdefgh"),
            "runId" to s("run_r1")
        ))),
        listOf(row("m3", owner, "user", mapOf(
            "toolResultsJson" to s("""[{"tool_call_id":"t","content":"","images":[{"s3_key":"${key(owner, "shot")}"}]}]"""),
            "attachments" to attachments(ref("bad", "elsewhere/bad"))
        )))
    )

    init {
        every { dynamo.query(any<QueryRequest>()) } answers {
            val request = firstArg<QueryRequest>()
            messageQueries += request
            val page = messageQueries.size - 1
            QueryResponse.builder().items(pages[page % 3]).apply {
                if (page % 3 < 2) lastEvaluatedKey(mapOf("conversationId" to s(conv), "messageId" to s("m${page % 3 + 1}")))
            }.build()
        }
        // No pending runs on the Conversation row
        every { dynamo.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(emptyMap()).build()
        coEvery { purgeRepository.markConversationPurgeStarted(owner, conv, any()) } returns true
        coEvery { purgeRepository.hasMessages(conv) } returns false
        every { encoding.isConfigured } returns true

        // Everything the conversation links to ...
        s3.put(key(owner, "img-o"), "retention" to "kept", "conv" to conv)
        s3.put(key(recipient, "pdf-r"), "retention" to "kept", "conv" to conv)
        s3.put(key(recipient, "pdf-r") + ".source.md", "retention" to "kept", "conv" to conv)
        s3.put(key(recipient, "pdf-r") + ".derived/text-v1.json", "retention" to "derived")
        s3.put("customers/$recipient/agent-fs/ns-abcdefgh/draft.md", "retention" to "scratch")
        s3.put("customers/$recipient/agent-fs/ns-abcdefgh/parts/1.md", "retention" to "scratch")
        s3.put(key(owner, "shot"))
        // ... and what it must not touch
        s3.put(key(owner, "other-conv"), "retention" to "kept", "conv" to "conv-2")
        s3.put("customers/$recipient/agent-fs/ns-otherturn/x.md", "retention" to "scratch")
        s3.put("elsewhere/bad")
    }

    private val linked = setOf(
        key(owner, "img-o"), key(recipient, "pdf-r"), key(recipient, "pdf-r") + ".source.md",
        key(recipient, "pdf-r") + ".derived/text-v1.json", "customers/$recipient/agent-fs/ns-abcdefgh/draft.md",
        "customers/$recipient/agent-fs/ns-abcdefgh/parts/1.md", key(owner, "shot")
    )

    @Test
    fun `every page is read and every linked object goes, recipients' included, and nothing else`() = runTest {
        val outcome = service.purge(job)

        assertIs<PurgeOutcome.Done>(outcome)
        assertEquals(3, messageQueries.size)
        assertTrue(messageQueries.all { it.projectionExpression() != null })
        for (k in linked) assertTrue(s3.tags(k) == null, "$k should be deleted")
        assertEquals(
            setOf(key(owner, "other-conv"), "customers/$recipient/agent-fs/ns-otherturn/x.md", "elsewhere/bad"),
            s3.objects.keys
        )
    }

    @Test
    fun `a linked key that another conversation keeps is left to that conversation`() = runTest {
        // A pre-claim duplicate: this conversation's row links an object conv-2 claimed
        s3.put(key(owner, "img-o"), "retention" to "kept", "conv" to "conv-2")

        service.purge(job)

        assertEquals(mapOf("retention" to "kept", "conv" to "conv-2"), s3.tags(key(owner, "img-o")))
    }

    @Test
    fun `derived sidecars are found even when an earlier attempt already deleted their PDF`() = runTest {
        s3.objects.remove(key(recipient, "pdf-r"))

        service.purge(job)

        assertEquals(null, s3.tags(key(recipient, "pdf-r") + ".derived/text-v1.json"))
    }

    @Test
    fun `S3 and run data go before the rows, and the Conversation row goes last`() = runTest {
        service.purge(job)

        coVerifyOrder {
            purgeRepository.markConversationPurgeStarted(owner, conv, any())
            s3.provider.deleteObjects(any())
            runData.deleteRunData("run_r1")
            encoding.deleteConversationVectors(any(), conv)
            purgeRepository.deleteMessages(conv, listOf("m1", "m2", "m3"))
            purgeRepository.hasMessages(conv)
            purgeRepository.deleteAllConversationShares(conv)
            purgeRepository.deleteConversationRow(owner, conv)
        }
        coVerify { encoding.deleteConversationVectors(owner, conv) }
        coVerify { encoding.deleteConversationVectors(recipient, conv) }
        coVerify { purgeRepository.deleteMemoryConversationMeta(recipient, conv) }
        coVerify { purgeRepository.deleteInstructionUsageSeen(owner, conv) }
    }

    @Test
    fun `after a crash past the S3 step a re-run finishes cleanly`() = runTest {
        coEvery { runData.deleteRunData("run_r1") } throws RuntimeException("retrieval-server restarting")
        assertFailsWith<RuntimeException> { service.purge(job) }
        // The rows still link everything: nothing was deleted from DynamoDB
        coVerify(exactly = 0) { purgeRepository.deleteMessages(any(), any()) }
        coVerify(exactly = 0) { purgeRepository.deleteConversationRow(any(), any()) }

        coEvery { runData.deleteRunData("run_r1") } returns Unit
        assertIs<PurgeOutcome.Done>(service.purge(job))
        coVerify(exactly = 1) { purgeRepository.deleteConversationRow(owner, conv) }
    }

    @Test
    fun `a live durable run is cancelled and the purge waits, deleting nothing`() = runTest {
        val pending = PendingRun("resp-1", "run_live", "CLAUDE", "m")
        every { dynamo.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(
            mapOf("pendingRuns" to AttributeValue.builder().ss(pending.encode()).build())
        ).build()
        coEvery { runData.runState("run_live") } returns RunDataClient.RunState.ACTIVE

        val outcome = service.purge(job)

        assertEquals(PurgeOutcome.Reschedule("pending run", pendingRun = true), outcome)
        coVerify { runs.cancelRun("run_live") }
        coVerify { jobs.addToSet(conv, "runIds", setOf("run_live")) }
        coVerify(exactly = 0) { s3.provider.deleteObjects(any()) }
        coVerify(exactly = 0) { runData.deleteRunData(any()) }
        coVerify(exactly = 0) { purgeRepository.deleteMessages(any(), any()) }
        assertTrue(linked.all { s3.tags(it) != null })
    }

    @Test
    fun `a finished or unknown pending run leaves the set and its data is deleted`() = runTest {
        val pending = PendingRun("resp-1", "run_done", "CLAUDE", "m")
        every { dynamo.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(
            mapOf("pendingRuns" to AttributeValue.builder().ss(pending.encode()).build())
        ).build()
        every { dynamo.updateItem(any<software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest>()) } returns
            software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse.builder().build()
        coEvery { runData.runState("run_done") } returns RunDataClient.RunState.UNKNOWN

        assertIs<PurgeOutcome.Done>(service.purge(job))
        coVerify { runData.deleteRunData("run_done") }
        coVerify { runData.deleteRunData("run_r1") }
    }

    @Test
    fun `message rows that survive the batch delete fail the attempt before the Conversation row goes`() = runTest {
        coEvery { purgeRepository.hasMessages(conv) } returns true

        assertFailsWith<PurgeStepException> { service.purge(job) }
        coVerify(exactly = 0) { purgeRepository.deleteConversationRow(any(), any()) }
    }

    @Test
    fun `without the encoding-server purge the vectors are skipped with a warning`() = runTest {
        every { encoding.isConfigured } returns false

        assertIs<PurgeOutcome.Done>(service.purge(job))
        coVerify(exactly = 0) { encoding.deleteConversationVectors(any(), any()) }
        coVerify { jobs.addWarning(conv, match { it.startsWith("vector_purge_skipped") }) }
    }

    @Test
    fun `a conversation is purged as an orphan only when its owner was deleted and no share is left`() = runTest {
        coEvery { jobs.get("ACCOUNT#$owner") } returns null
        assertEquals(false, service.enqueueIfOrphaned(conv, owner))

        coEvery { jobs.get("ACCOUNT#$owner") } returns PurgeJob("ACCOUNT#$owner", PurgeJobType.ACCOUNT, owner)
        coEvery { purgeRepository.conversationShareRecipients(conv) } returns listOf("PUBLIC")
        assertEquals(false, service.enqueueIfOrphaned(conv, owner))

        coEvery { purgeRepository.conversationShareRecipients(conv) } returns emptyList()
        coEvery { jobs.createIfAbsent(any(), any()) } returns true
        assertEquals(true, service.enqueueIfOrphaned(conv, owner))
        coVerify {
            jobs.createIfAbsent(match { it.jobKey == conv && it.type == PurgeJobType.CONVERSATION && it.customerId == owner }, any())
        }
    }
}
