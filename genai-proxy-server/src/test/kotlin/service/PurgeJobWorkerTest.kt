package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobState
import com.genflowly.repository.PurgeJobType
import com.genflowly.testsupport.FakePurgeJobs
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PurgeJobWorkerTest {

    private val now = Instant.parse("2026-10-15T12:00:00Z")
    private val jobs = FakePurgeJobs()
    private val accounts = mockk<AccountDeletionService>()
    private val conversations = mockk<ConversationPurgeService>()
    private val worker = PurgeJobWorker(jobs.repository, accounts, conversations, AppScope()) { now }

    private fun enqueue(job: PurgeJob) {
        jobs.jobs[job.jobKey] = job.copy(dueAt = now.minusSeconds(1).toString())
    }

    private val conversationJob = PurgeJob("conv-1", PurgeJobType.CONVERSATION, "CU1", conversationId = "conv-1")
    private val accountJob = PurgeJob("ACCOUNT#CU1", PurgeJobType.ACCOUNT, "CU1")

    @Test
    fun `due jobs run under a lease and finished ones are marked done`() = runTest {
        enqueue(conversationJob)
        enqueue(accountJob)
        coEvery { conversations.purge(any()) } returns PurgeOutcome.Done
        coEvery { accounts.run(any()) } returns PurgeOutcome.Done

        assertEquals(2, worker.pollOnce())

        assertEquals(PurgeJobState.DONE, jobs.jobs["conv-1"]!!.state)
        assertEquals(PurgeJobState.DONE, jobs.jobs["ACCOUNT#CU1"]!!.state)
        assertEquals(0, worker.pollOnce())
    }

    @Test
    fun `a job someone else holds the lease of is not run`() = runTest {
        enqueue(conversationJob.copy(leaseUntil = now.plusSeconds(60).toString()))

        assertFalse(worker.runJob(jobs.jobs["conv-1"]!!))
        coVerify(exactly = 0) { conversations.purge(any()) }
    }

    @Test
    fun `waiting on a pending run reschedules in five minutes, and counts as a failure after six waits`() = runTest {
        enqueue(conversationJob)
        coEvery { conversations.purge(any()) } returns PurgeOutcome.Reschedule("pending run", pendingRun = true)

        worker.runJob(jobs.jobs["conv-1"]!!)
        var job = jobs.jobs["conv-1"]!!
        assertEquals(PurgeJobState.PENDING, job.state)
        assertEquals(now.plus(Duration.ofMinutes(5)).toString(), job.dueAt)
        assertEquals(1, job.reschedules)
        assertEquals(0, job.attempts)

        jobs.jobs["conv-1"] = job.copy(reschedules = PurgeJobWorker.MAX_PENDING_RUN_RESCHEDULES)
        worker.runJob(jobs.jobs["conv-1"]!!)
        job = jobs.jobs["conv-1"]!!
        assertEquals(1, job.attempts)
        assertTrue(job.lastError!!.contains("pending"))
    }

    @Test
    fun `a failed attempt backs off exponentially and records the error`() = runTest {
        enqueue(conversationJob.copy(attempts = 2))
        coEvery { conversations.purge(any()) } throws PurgeStepException("s3", "3 object(s) could not be deleted")

        assertTrue(worker.runJob(jobs.jobs["conv-1"]!!))

        val job = jobs.jobs["conv-1"]!!
        assertEquals(3, job.attempts)
        assertEquals(now.plus(Duration.ofMinutes(4)).toString(), job.dueAt)
        assertTrue(job.lastError!!.startsWith("PurgeStepException"))
        assertEquals(PurgeJobState.PENDING, job.state)
    }

    @Test
    fun `waiting for conversation purges is not a failure`() = runTest {
        enqueue(accountJob)
        coEvery { accounts.run(any()) } returns PurgeOutcome.Reschedule("conversation purges")

        worker.runJob(jobs.jobs["ACCOUNT#CU1"]!!)

        val job = jobs.jobs["ACCOUNT#CU1"]!!
        assertEquals(0, job.attempts)
        assertEquals(0, job.reschedules)
        assertEquals(now.plus(PurgeJobWorker.RESCHEDULE_DELAY).toString(), job.dueAt)
    }

    @Test
    fun `backoff doubles from one minute and is capped at six hours`() {
        assertEquals(Duration.ofMinutes(1), PurgeJobWorker.backoff(1))
        assertEquals(Duration.ofMinutes(8), PurgeJobWorker.backoff(4))
        assertEquals(Duration.ofHours(6), PurgeJobWorker.backoff(10))
        assertEquals(Duration.ofHours(6), PurgeJobWorker.backoff(1000))
    }
}
