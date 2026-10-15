package com.genflowly.testsupport

import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobState
import io.mockk.coEvery
import io.mockk.mockk
import java.time.Instant

/** The PurgeJobs table in memory behind a mocked [PurgeJobRepository]. */
class FakePurgeJobs {
    val jobs = linkedMapOf<String, PurgeJob>()
    val repository: PurgeJobRepository = mockk()

    private fun update(key: String, change: (PurgeJob) -> PurgeJob) {
        jobs[key]?.let { jobs[key] = change(it) }
    }

    init {
        coEvery { repository.createIfAbsent(any(), any()) } answers {
            val job = firstArg<PurgeJob>()
            if (job.jobKey in jobs) false
            else {
                jobs[job.jobKey] = job.copy(state = PurgeJobState.PENDING, dueAt = secondArg<Instant>().toString())
                true
            }
        }
        coEvery { repository.get(any()) } answers { jobs[firstArg()] }
        coEvery { repository.dueJobs(any(), any()) } answers {
            jobs.values.filter { it.state != PurgeJobState.DONE && (it.dueAt == null || it.dueAt!! <= firstArg<Instant>().toString()) }
        }
        coEvery { repository.tryLease(any(), any(), any()) } answers {
            val job = jobs[firstArg()]
            val now = secondArg<Instant>().toString()
            if (job == null || job.state == PurgeJobState.DONE || (job.leaseUntil != null && job.leaseUntil!! > now)) false
            else {
                jobs[job.jobKey] = job.copy(state = PurgeJobState.RUNNING, leaseUntil = thirdArg<Instant>().toString())
                true
            }
        }
        coEvery { repository.recordStage(any(), any(), any()) } answers {
            update(firstArg()) { it.copy(stage = secondArg()) }
        }
        coEvery { repository.addWarning(any(), any()) } answers {
            update(firstArg()) { if (secondArg<String>() in it.warnings) it else it.copy(warnings = it.warnings + secondArg<String>()) }
        }
        coEvery { repository.addToSet(any(), any(), any()) } answers {
            val values = thirdArg<Collection<String>>().toSet()
            update(firstArg()) {
                when (secondArg<String>()) {
                    "childKeys" -> it.copy(childKeys = it.childKeys + values)
                    "runIds" -> it.copy(runIds = it.runIds + values)
                    else -> error("Unknown set ${secondArg<String>()}")
                }
            }
        }
        coEvery { repository.reschedule(any(), any(), any(), any(), any()) } answers {
            val failed = thirdArg<Boolean>()
            val rescheduled = arg<Boolean>(3)
            update(firstArg()) {
                it.copy(
                    state = PurgeJobState.PENDING, leaseUntil = null, dueAt = secondArg<Instant>().toString(),
                    attempts = it.attempts + if (failed) 1 else 0,
                    reschedules = it.reschedules + if (rescheduled) 1 else 0,
                    lastError = arg<String?>(4) ?: it.lastError
                )
            }
        }
        coEvery { repository.complete(any()) } answers {
            update(firstArg()) {
                it.copy(state = PurgeJobState.DONE, leaseUntil = null, dueAt = null, authSub = null, authClient = null)
            }
        }
    }
}
