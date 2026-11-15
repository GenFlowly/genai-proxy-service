package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.di.AppScope
import com.genflowly.providers.Auth0ManagementClient
import com.genflowly.providers.CustomerDocumentsPurger
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.S3Provider
import com.genflowly.repository.PurgeRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobType
import com.genflowly.service.AccountDeletionService.Companion.FINAL_SWEEP_DELAY
import com.genflowly.service.AccountDeletionService.Companion.STAGE_CONTENT
import com.genflowly.service.AccountDeletionService.Companion.STAGE_DISCONNECTED
import com.genflowly.service.AccountDeletionService.Companion.STAGE_LOGIN
import com.genflowly.service.AccountDeletionService.Companion.STAGE_VECTORS
import com.genflowly.service.AccountDeletionService.Companion.VECTOR_ATTEMPTS
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.MockKMatcherScope
import io.mockk.coVerifyOrder
import io.mockk.every
import io.mockk.mockk
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Self-service account deletion. Pinned here: the login is cut off before
 * the request returns; content goes before vectors and vectors before the
 * credentials that reach them; a resumed job skips finished stages; the
 * final sweep repeats the deletes a late reply could undo; and the login
 * survives when it also holds another account.
 */
class AccountDeletionServiceTest {

    private val jobs = mockk<PurgeJobRepository>(relaxed = true)
    private val purge = mockk<PurgeRepository>(relaxed = true)
    private val profiles = mockk<CustomerProfileRepository>()
    private val s3 = mockk<S3Provider>()
    private val documents = mockk<CustomerDocumentsPurger>()
    private val retrieval = mockk<RetrievalServerClient>()
    private val auth0 = mockk<Auth0ManagementClient>()
    private var now: Instant = Instant.parse("2026-11-05T12:00:00Z")
    private val runner = PurgeJobRunner(jobs) { now }
    private val service = AccountDeletionService(jobs, runner, purge, profiles, s3, documents, retrieval, auth0, AppScope()) { now }
    private val worker = PurgeJobWorker(jobs, runner, mapOf(PurgeJobType.ACCOUNT to service), AppScope()) { now }

    init {
        coEvery { profiles.getCustomerProfileByCustomerId("CU1") } returns profile("REACT_APP")
        coEvery { purge.ownedConversationIds("CU1") } returns listOf("C1", "C2")
        coEvery { purge.instructionIdsByCreator("CU1") } returns emptySet()
        coEvery { purge.ownedGraphIds("CU1") } returns setOf("G1")
        coEvery { purge.ownedNodeIds("CU1") } returns setOf("N1")
        coEvery { purge.systemNodeConfigs() } returns emptyList()
        coEvery { purge.customerIdsForSub("auth0|u1") } returns emptyList()
        coEvery { retrieval.deleteCustomerVectors("CU1") } returns 12
        every { s3.isConfigured } returns true
        coEvery { s3.listKeys("customers/CU1/") } returns listOf("customers/CU1/a.png")
        coEvery { s3.deleteObjects(any()) } returns emptyList()
        every { documents.isConfigured } returns true
        coEvery { documents.purgeCustomer("CU1") } returns 2
        coEvery { auth0.deleteUser("auth0|u1") } returns Auth0ManagementClient.DeleteResult.DELETED
    }

    private fun profile(client: String) = mapOf(
        DynamoDBConstants.SUB_PARTITION_KEY to AttributeValue.builder().s("auth0|u1").build(),
        DynamoDBConstants.CLIENT_SORT_KEY to AttributeValue.builder().s(client).build(),
        DynamoDBConstants.USERNAME_KEY to AttributeValue.builder().s("alex-abc123").build(),
        DynamoDBConstants.CUSTOMER_ID_KEY to AttributeValue.builder().s("CU1").build(),
    )

    private fun MockKMatcherScope.account(): PurgeJob = match { it.jobKey == "ACCOUNT#CU1" }

    private fun job(stage: Int, requestedAt: Instant = now, attempts: Int = 1) = PurgeJob(
        type = PurgeJobType.ACCOUNT, customerId = "CU1", sub = "auth0|u1", client = "REACT_APP", username = "alex-abc123",
        requestedAt = requestedAt, stage = stage, attempts = attempts, dueAt = "2026-11-05T11:00:00Z"
    )

    @Test
    fun `a request cuts the login off before it returns, then deletes the rest in the background`() = runTest {
        coEvery { jobs.createIfAbsent(any(), any()) } returns true
        coEvery { jobs.get(PurgeJobType.ACCOUNT, "CU1") } returns job(stage = 0)

        service.requestDeletion("CU1")

        coVerifyOrder {
            jobs.createIfAbsent(match { it.sub == "auth0|u1" && it.username == "alex-abc123" }, now.plus(PurgeJobRunner.LEASE))
            purge.deleteDeveloperApiKeys("CU1")
            purge.deleteProfile("auth0|u1", "REACT_APP", "CU1")
            purge.deleteUsername("alex-abc123", "CU1")
            jobs.recordStage(account(), STAGE_DISCONNECTED, any())
        }
        coVerify(timeout = 5_000) { auth0.deleteUser("auth0|u1") }
        coVerify(timeout = 5_000) { jobs.reschedule(account(), now.plus(FINAL_SWEEP_DELAY)) }
    }

    @Test
    fun `asking again repeats the disconnect but starts no second run`() = runTest {
        coEvery { jobs.createIfAbsent(any(), any()) } returns false
        coEvery { jobs.get(PurgeJobType.ACCOUNT, "CU1") } returns job(stage = STAGE_CONTENT)

        service.requestDeletion("CU1")

        coVerify { purge.deleteProfile("auth0|u1", "REACT_APP", "CU1") }
        coVerify { jobs.recordStage(account(), STAGE_CONTENT, any()) }
        coVerify(exactly = 0) { retrieval.deleteCustomerVectors(any()) }
    }

    @Test
    fun `a failed disconnect makes the job due at once and fails the request`() = runTest {
        coEvery { jobs.createIfAbsent(any(), any()) } returns true
        coEvery { jobs.get(PurgeJobType.ACCOUNT, "CU1") } returns job(stage = 0)
        coEvery { purge.deleteProfile(any(), any(), any()) } throws IllegalStateException("throttled")

        assertFailsWith<IllegalStateException> { service.requestDeletion("CU1") }

        coVerify { jobs.reschedule(account(), now) }
    }

    @Test
    fun `admin-panel accounts are refused`() = runTest {
        coEvery { profiles.getCustomerProfileByCustomerId("CU1") } returns profile("ADMIN_PANEL")

        assertFailsWith<AccountDeletionRefusedException> { service.requestDeletion("CU1") }

        coVerify(exactly = 0) { jobs.createIfAbsent(any(), any()) }
    }

    @Test
    fun `ids that could widen a file prefix are refused`() = runTest {
        for (bad in listOf("", "CU/1", "CU 1", "System", "public", "a*", "x".repeat(65))) {
            assertFalse(AccountDeletionService.isDeletableCustomerId(bad), bad)
            assertFailsWith<IllegalArgumentException> { service.requestDeletion(bad) }
        }
        assertTrue(AccountDeletionService.isDeletableCustomerId("CU20EA760EBA18"))
        coVerify(exactly = 0) { jobs.createIfAbsent(any(), any()) }
    }

    @Test
    fun `content goes before the vectors, and vectors before the credentials that reach them`() = runTest {
        val outcome = service.run(job(stage = STAGE_DISCONNECTED))

        assertEquals(PurgeOutcome.WaitUntil(now.plus(FINAL_SWEEP_DELAY)), outcome)
        coVerifyOrder {
            purge.deleteConversation("CU1", "C1")
            purge.deleteConversation("CU1", "C2")
            purge.deleteSharesWith("CU1")
            purge.deleteGraph("G1")
            purge.deleteNode("N1")
            purge.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_NOTES_TABLE, DynamoDBConstants.NOTE_KEY)
            purge.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_MEMORY_TABLE, DynamoDBConstants.MEMORY_ID_KEY)
            jobs.recordStage(account(), STAGE_CONTENT, any())
            retrieval.deleteCustomerVectors("CU1")
            jobs.recordStage(account(), STAGE_VECTORS, any())
            purge.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_API_KEY_TABLE, DynamoDBConstants.AI_VENDOR_KEY)
            purge.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_VECTOR_DB_CONFIG_TABLE, null)
            s3.deleteObjects(listOf("customers/CU1/a.png"))
            documents.purgeCustomer("CU1")
            auth0.deleteUser("auth0|u1")
            jobs.recordStage(account(), STAGE_LOGIN, any())
        }
    }

    @Test
    fun `a resumed job skips the stages it finished`() = runTest {
        service.run(job(stage = STAGE_VECTORS))

        coVerify(exactly = 0) { purge.deleteConversation(any(), any()) }
        coVerify(exactly = 0) { retrieval.deleteCustomerVectors(any()) }
        coVerify { purge.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_API_KEY_TABLE, DynamoDBConstants.AI_VENDOR_KEY) }
        coVerify { auth0.deleteUser("auth0|u1") }
    }

    @Test
    fun `the final sweep repeats content, credentials and files, then finishes`() = runTest {
        val outcome = service.run(job(stage = STAGE_LOGIN, requestedAt = now.minus(Duration.ofMinutes(16))))

        assertEquals(PurgeOutcome.Done, outcome)
        coVerify { purge.deleteConversation("CU1", "C1") }
        coVerify { purge.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE, DynamoDBConstants.TOOL_TYPE_KEY) }
        coVerify { s3.deleteObjects(listOf("customers/CU1/a.png")) }
        coVerify(exactly = 0) { retrieval.deleteCustomerVectors(any()) }
        coVerify(exactly = 0) { auth0.deleteUser(any()) }
    }

    @Test
    fun `an unreachable vector DB fails the attempt until the last one, then is skipped with a warning`() = runTest {
        coEvery { retrieval.deleteCustomerVectors("CU1") } throws IllegalStateException("Vector purge failed: 500")

        assertFailsWith<IllegalStateException> { service.run(job(stage = STAGE_CONTENT, attempts = 1)) }
        coVerify(exactly = 0) { purge.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_VECTOR_DB_CONFIG_TABLE, null) }

        service.run(job(stage = STAGE_CONTENT, attempts = VECTOR_ATTEMPTS))
        coVerify { jobs.addWarning(account(), match { it.startsWith("vectors_not_deleted") }) }
        coVerify { purge.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_VECTOR_DB_CONFIG_TABLE, null) }
    }

    @Test
    fun `files S3 refuses to delete fail the stage`() = runTest {
        coEvery { s3.deleteObjects(any()) } returns listOf("customers/CU1/a.png")

        assertFailsWith<IllegalStateException> { service.run(job(stage = STAGE_VECTORS + 1)) }

        coVerify(exactly = 0) { auth0.deleteUser(any()) }
    }

    @Test
    fun `the login is kept when it also holds another account`() = runTest {
        coEvery { purge.customerIdsForSub("auth0|u1") } returns listOf("CU2")

        service.run(job(stage = STAGE_LOGIN - 1))

        coVerify(exactly = 0) { auth0.deleteUser(any()) }
        coVerify { jobs.addWarning(account(), match { it.startsWith("auth0_user_kept") }) }
    }

    @Test
    fun `without Auth0 management credentials the login is kept with a warning`() = runTest {
        coEvery { auth0.deleteUser("auth0|u1") } returns Auth0ManagementClient.DeleteResult.NOT_CONFIGURED

        service.run(job(stage = STAGE_LOGIN - 1))

        coVerify { jobs.addWarning(account(), match { it.startsWith("auth0_not_configured") }) }
        coVerify { jobs.recordStage(account(), STAGE_LOGIN, any()) }
    }

    @Test
    fun `instructions that System agents use are kept`() = runTest {
        coEvery { purge.instructionIdsByCreator("CU1") } returns setOf("I-1", "I-2", "I-3")
        coEvery { purge.systemNodeConfigs() } returns listOf(
            """{"instruction_id":"I-1","tools":[{"subagents":[{"harness_instruction_id":"I-2"}]}]}""",
            "not json"
        )

        service.run(job(stage = STAGE_DISCONNECTED))

        coVerify { purge.deleteInstruction("I-3") }
        coVerify(exactly = 0) { purge.deleteInstruction("I-1") }
        coVerify(exactly = 0) { purge.deleteInstruction("I-2") }
        coVerify { jobs.addWarning(account(), "instructions_kept: 2 instruction(s) are used by System agents") }
    }

    @Test
    fun `the sweep claims due jobs and completes those past their final sweep`() = runTest {
        val due = job(stage = STAGE_LOGIN, requestedAt = now.minus(Duration.ofHours(1)))
        coEvery { jobs.dueJobs(now, any()) } returns listOf(due)
        coEvery { jobs.claim(due, any()) } returns due.copy(attempts = 2)

        worker.processDueJobs()

        coVerify { jobs.complete(account(), now) }
    }

    @Test
    fun `a job another instance claimed first is left alone`() = runTest {
        val due = job(stage = STAGE_LOGIN, requestedAt = now.minus(Duration.ofHours(1)))
        coEvery { jobs.dueJobs(now, any()) } returns listOf(due)
        coEvery { jobs.claim(due, any()) } returns null

        worker.processDueJobs()

        coVerify(exactly = 0) { purge.deleteConversation(any(), any()) }
        coVerify(exactly = 0) { jobs.complete(any(), any()) }
    }

    @Test
    fun `a failed attempt records the error and backs off`() = runTest {
        val due = job(stage = STAGE_DISCONNECTED, attempts = 0)
        coEvery { jobs.dueJobs(now, any()) } returns listOf(due)
        coEvery { jobs.claim(due, any()) } returns due.copy(attempts = 2)
        coEvery { purge.ownedConversationIds("CU1") } throws IllegalStateException("throttled")

        worker.processDueJobs()

        coVerify { jobs.recordError(account(), "throttled") }
        coVerify { jobs.reschedule(account(), now.plusSeconds(PurgeJobRunner.retryDelaySeconds(2))) }
        coVerify(exactly = 0) { jobs.complete(any(), any()) }
    }

    @Test
    fun `instruction references are found at any depth`() {
        val config = Json.parseToJsonElement(
            """{"instruction_id":"A","x":[{"y":{"instruction_id":"B","harness_instruction_id":"C"}},{"instruction_id":""}]}"""
        )
        assertEquals(listOf("A", "B", "C"), AccountDeletionService.instructionRefs(config).sorted())
    }
}
