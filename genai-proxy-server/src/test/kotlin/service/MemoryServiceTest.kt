package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.Message
import com.genflowly.models.api.CopyMemoryRequest
import com.genflowly.models.api.CreateMemoryRequest
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.EditMemoryRequest
import com.genflowly.models.api.MemoryChange
import com.genflowly.models.api.MemoryChangeType
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemoryPlacement
import com.genflowly.models.api.MemorySourceType
import com.genflowly.models.api.MemoryUsage
import com.genflowly.models.api.MoveMemoryRequest
import com.genflowly.models.api.Project
import com.genflowly.repository.MemoryChangeCause
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.ProjectRepository
import com.genflowly.repository.PurgeRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Managing memories by hand: adding, editing (always a new version), moving
 * (changes where it applies), copying (project to project only, one shared
 * memory) and deleting (one project or everywhere). Versions and change log
 * are never rewritten by any of these.
 */
class MemoryServiceTest {

    private val memoryRepo = mockk<MemoryRepository>()
    private val vectors = mockk<MemoryVectorService>(relaxed = true)
    private val purge = mockk<PurgeRepository>(relaxed = true)
    private val projects = mockk<ProjectRepository>()
    private val conversations = mockk<ConversationService>()
    private val service = MemoryService(memoryRepo, mockk(), vectors, purge, projects, conversations, AppScope())

    private val profileCore = MemoryPlacement(null, MemoryKind.CORE)
    private val inA = MemoryPlacement("PRJa", MemoryKind.CORE)
    private val inB = MemoryPlacement("PRJb", MemoryKind.EPISODIC)

    private fun memory(vararg placements: MemoryPlacement, version: Int = 2, tracked: Boolean = true) = CustomerMemory(
        memoryId = "MEM#1", text = "Prefers short answers.", kind = placements.first().kind,
        sourceType = MemorySourceType.CONVERSATION, sourceId = "CONV1", createdAt = "2026-09-19T16:44:00Z",
        updatedAt = "t", placements = placements.toList(), version = version, tracked = tracked, rev = 4
    )

    private fun stored(memory: CustomerMemory?) {
        coEvery { memoryRepo.getMemory("CU1", "MEM#1") } returns memory
    }

    private fun projectExists(vararg ids: String) {
        coEvery { projects.getProject("CU1", any()) } answers {
            val id = secondArg<String>()
            if (id in ids) Project(id, "Project $id", "t", "t") else null
        }
    }

    private fun placementsSet() {
        coEvery { memoryRepo.setPlacements(any(), any(), any(), any(), any(), any()) } returns true
    }

    // ── Add ────────────────────────────────────────────────────────────────

    @Test
    fun `a memory added to a project applies only there, as version 1 by you`() = runTest {
        projectExists("PRJa")
        coEvery { memoryRepo.createMemory(any(), any(), any(), any(), any(), any(), any()) } returns memory(inA, version = 1)

        service.createMemory("CU1", CreateMemoryRequest("  Report due Dec 12.  ", MemoryKind.CORE, "PRJa"))

        coVerify {
            memoryRepo.createMemory(
                "CU1", "Report due Dec 12.", listOf(inA), null, MemorySourceType.USER, null,
                MemoryChangeCause(MemoryChangeType.ADDED_BY_YOU)
            )
        }
        coVerify(timeout = 5_000) { vectors.encode("CU1", any()) }
    }

    @Test
    fun `adding needs text and a real project`() = runTest {
        projectExists()

        assertFailsWith<MemoryRequestException> { service.createMemory("CU1", CreateMemoryRequest("   ", MemoryKind.CORE)) }
        assertFailsWith<MemoryRequestException> { service.createMemory("CU1", CreateMemoryRequest("x".repeat(501), MemoryKind.CORE)) }
        assertFailsWith<MemoryRequestException> { service.createMemory("CU1", CreateMemoryRequest("Fact.", MemoryKind.CORE, "PRJgone")) }
        coVerify(exactly = 0) { memoryRepo.createMemory(any(), any(), any(), any(), any(), any(), any()) }
    }

    // ── Edit ───────────────────────────────────────────────────────────────

    @Test
    fun `an edit saves a new version of the memory as read`() = runTest {
        val current = memory(profileCore)
        stored(current)
        coEvery { memoryRepo.updateMemoryText(any(), any(), any(), any()) } returns true

        service.editMemory("CU1", "MEM#1", EditMemoryRequest("Prefers concise answers.", baseVersion = 2))

        coVerify { memoryRepo.updateMemoryText("CU1", current, "Prefers concise answers.", MemoryChangeCause(MemoryChangeType.EDITED_BY_YOU)) }
        coVerify(timeout = 5_000) { vectors.encode("CU1", any()) }
    }

    @Test
    fun `an edit started from an older version is refused`() = runTest {
        stored(memory(profileCore, version = 3))

        assertFailsWith<MemoryConflictException> {
            service.editMemory("CU1", "MEM#1", EditMemoryRequest("Prefers concise answers.", baseVersion = 2))
        }
        coVerify(exactly = 0) { memoryRepo.updateMemoryText(any(), any(), any(), any()) }
    }

    @Test
    fun `saving the same text makes no new version`() = runTest {
        stored(memory(profileCore))

        service.editMemory("CU1", "MEM#1", EditMemoryRequest("Prefers short answers.", baseVersion = 2))

        coVerify(exactly = 0) { memoryRepo.updateMemoryText(any(), any(), any(), any()) }
    }

    @Test
    fun `a write refused because the memory changed is a conflict, because it is gone is not found`() = runTest {
        coEvery { memoryRepo.updateMemoryText(any(), any(), any(), any()) } returns false
        coEvery { memoryRepo.getMemory("CU1", "MEM#1") } returnsMany listOf(memory(profileCore), memory(profileCore))
        assertFailsWith<MemoryConflictException> {
            service.editMemory("CU1", "MEM#1", EditMemoryRequest("New.", baseVersion = 2))
        }

        coEvery { memoryRepo.getMemory("CU1", "MEM#1") } returnsMany listOf(memory(profileCore), null)
        assertFailsWith<MemoryNotFoundException> {
            service.editMemory("CU1", "MEM#1", EditMemoryRequest("New.", baseVersion = 2))
        }
    }

    // ── Move ───────────────────────────────────────────────────────────────

    @Test
    fun `moving within Profile changes its kind`() = runTest {
        stored(memory(profileCore))
        placementsSet()

        service.moveMemory("CU1", "MEM#1", MoveMemoryRequest(fromProjectId = null, toProjectId = null, kind = MemoryKind.EPISODIC))

        val episodic = MemoryPlacement(null, MemoryKind.EPISODIC)
        coVerify {
            memoryRepo.setPlacements(
                "CU1", any(), listOf(episodic), MemoryChangeCause(MemoryChangeType.MOVED),
                from = listOf(profileCore), to = listOf(episodic)
            )
        }
    }

    @Test
    fun `moving a project memory to Profile drops every project it was in`() = runTest {
        stored(memory(inA, inB))
        placementsSet()

        service.moveMemory("CU1", "MEM#1", MoveMemoryRequest(fromProjectId = "PRJa", toProjectId = null, kind = MemoryKind.CORE))

        coVerify {
            memoryRepo.setPlacements(
                "CU1", any(), listOf(profileCore), any(), from = listOf(inA, inB), to = listOf(profileCore)
            )
        }
    }

    @Test
    fun `moving between projects replaces the source and keeps the others`() = runTest {
        projectExists("PRJc")
        stored(memory(inA, inB))
        placementsSet()

        service.moveMemory("CU1", "MEM#1", MoveMemoryRequest(fromProjectId = "PRJa", toProjectId = "PRJc", kind = MemoryKind.EPISODIC))

        val inC = MemoryPlacement("PRJc", MemoryKind.EPISODIC)
        coVerify { memoryRepo.setPlacements("CU1", any(), listOf(inB, inC), any(), from = listOf(inA), to = listOf(inC)) }
    }

    @Test
    fun `a move must start where the memory applies and must change something`() = runTest {
        stored(memory(profileCore))

        assertFailsWith<MemoryRequestException> {
            service.moveMemory("CU1", "MEM#1", MoveMemoryRequest(fromProjectId = "PRJa", toProjectId = null, kind = MemoryKind.CORE))
        }
        assertFailsWith<MemoryRequestException> {
            service.moveMemory("CU1", "MEM#1", MoveMemoryRequest(fromProjectId = null, toProjectId = null, kind = MemoryKind.CORE))
        }
    }

    // ── Copy ───────────────────────────────────────────────────────────────

    @Test
    fun `copying adds the target project to the same memory`() = runTest {
        projectExists("PRJb")
        stored(memory(inA))
        placementsSet()

        service.copyMemory("CU1", "MEM#1", CopyMemoryRequest("PRJa", "PRJb", MemoryKind.EPISODIC))

        coVerify {
            memoryRepo.setPlacements(
                "CU1", any(), listOf(inA, inB), MemoryChangeCause(MemoryChangeType.COPIED),
                from = listOf(inA), to = listOf(inB)
            )
        }
        coVerify(exactly = 0) { memoryRepo.createMemory(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `Profile memories can't be copied, nor into a project that already has them`() = runTest {
        projectExists("PRJb")
        stored(memory(profileCore))
        assertFailsWith<MemoryRequestException> {
            service.copyMemory("CU1", "MEM#1", CopyMemoryRequest("PRJa", "PRJb", MemoryKind.CORE))
        }

        stored(memory(inA, inB))
        assertFailsWith<MemoryRequestException> {
            service.copyMemory("CU1", "MEM#1", CopyMemoryRequest("PRJa", "PRJb", MemoryKind.CORE))
        }
    }

    // ── Delete ─────────────────────────────────────────────────────────────

    @Test
    fun `deleting from one of several projects only removes it there`() = runTest {
        stored(memory(inA, inB))
        placementsSet()

        assertFalse(service.deleteMemory("CU1", "MEM#1", "PRJa"))

        coVerify {
            memoryRepo.setPlacements(
                "CU1", any(), listOf(inB), MemoryChangeCause(MemoryChangeType.REMOVED_FROM_PROJECT),
                from = listOf(inA), to = emptyList()
            )
        }
        coVerify(exactly = 0) { memoryRepo.deleteMemory(any(), any()) }
    }

    @Test
    fun `deleting its last place deletes the memory, its logs and its vectors`() = runTest {
        stored(memory(inA))
        coEvery { memoryRepo.deleteMemory("CU1", "MEM#1") } returns true

        assertTrue(service.deleteMemory("CU1", "MEM#1", "PRJa"))

        coVerify(timeout = 5_000) { purge.deleteMemoryHistory("CU1", "MEM#1") }
        coVerify(timeout = 5_000) { vectors.delete("CU1", "MEM#1") }
    }

    @Test
    fun `deleting a project removes its memories as decided`() = runTest {
        val shared = memory(inA, inB)
        val only = memory(inA).copy(memoryId = "MEM#2")
        coEvery { memoryRepo.getMemories("CU1") } returns listOf(shared, only, memory(profileCore).copy(memoryId = "MEM#3"))
        coEvery { memoryRepo.getMemory("CU1", "MEM#1") } returns shared
        coEvery { memoryRepo.getMemory("CU1", "MEM#2") } returns only
        coEvery { memoryRepo.deleteMemory("CU1", "MEM#2") } returns true
        placementsSet()

        service.removeProject("CU1", "PRJa")

        coVerify { memoryRepo.setPlacements("CU1", shared, listOf(inB), any(), any(), any()) }
        coVerify { memoryRepo.deleteMemory("CU1", "MEM#2") }
        coVerify(exactly = 0) { memoryRepo.getMemory("CU1", "MEM#3") }
    }

    // ── Detail and usage ───────────────────────────────────────────────────

    private fun userMessage(customerId: String, text: String, role: String = "user") = Message(
        messageId = "M2", conversationId = "CONV1", text = text, client = "test", role = role,
        customerId = customerId, systemPrompt = "", aiConfig = emptyList(), previousMessageId = null
    )

    @Test
    fun `the detail quotes the user's own words and lists versions newest first`() = runTest {
        stored(memory(profileCore, version = 2))
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns listOf(
            MemoryChange("c1", MemoryChangeType.LEARNED, "t1", version = 1, text = "Short.", conversationId = "CONV1", messageId = "M2"),
            MemoryChange("c2", MemoryChangeType.MOVED, "t2"),
            MemoryChange("c3", MemoryChangeType.EDITED_BY_YOU, "t3", version = 2, text = "Prefers short answers.", previousText = "Short."),
        )
        coEvery { conversations.getConversationTitle("CONV1", "CU1") } returns "Weekly Report Format"
        coEvery { conversations.getMessage("CONV1", "M2") } returns userMessage("CU1", "Keep answers short.")

        val detail = service.getMemoryDetail("CU1", "MEM#1")

        assertEquals(listOf("c3", "c2", "c1"), detail.changes.map { it.changeId })
        assertEquals(listOf(2, 1), detail.versions.map { it.version })
        val learned = detail.changes.last()
        assertEquals("Weekly Report Format", learned.conversationTitle)
        assertEquals(true, learned.conversationAvailable)
        assertEquals("Keep answers short.", learned.youSaid)
    }

    @Test
    fun `other people's words and deleted conversations are never quoted`() = runTest {
        stored(memory(profileCore))
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns listOf(
            MemoryChange("c1", MemoryChangeType.LEARNED, "t1", version = 1, conversationId = "CONV1", messageId = "M2"),
            MemoryChange("c2", MemoryChangeType.UPDATED, "t2", version = 2, conversationId = "GONE", messageId = "M9"),
        )
        coEvery { conversations.getConversationTitle("CONV1", "CU1") } returns "Shared plan"
        coEvery { conversations.getConversationTitle("GONE", "CU1") } throws ConversationAccessDeniedException("not found")
        coEvery { conversations.getMessage("CONV1", "M2") } returns userMessage("CU-other", "My secret.")

        val detail = service.getMemoryDetail("CU1", "MEM#1")

        val (updated, learned) = detail.changes
        assertNull(learned.youSaid)
        assertEquals(false, updated.conversationAvailable)
        assertNull(updated.youSaid)
        coVerify(exactly = 0) { conversations.getMessage("GONE", any()) }
    }

    @Test
    fun `a memory from before versions shows its current text as version 1`() = runTest {
        stored(memory(profileCore, version = 1, tracked = false))
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns emptyList()
        coEvery { conversations.getConversationTitle("CONV1", "CU1") } returns "Old chat"

        val detail = service.getMemoryDetail("CU1", "MEM#1")

        val only = detail.versions.single()
        assertEquals(MemoryChangeType.LEGACY, only.type)
        assertEquals(1, only.version)
        assertEquals("Prefers short answers.", only.text)
        assertEquals("CONV1", only.conversationId)
    }

    @Test
    fun `a usage page carries titles and the hit counter`() = runTest {
        stored(memory(profileCore).copy(hitCount = 198))
        coEvery { memoryRepo.getUsagePage("CU1", "MEM#1", 25, null) } returns (
            listOf(
                MemoryUsage("CONV1", "m1", "t2", "core"),
                MemoryUsage("CONV1", "m0", "t1", "core"),
                MemoryUsage("GONE", "m9", "t0", "recalled"),
            ) to "next"
        )
        coEvery { conversations.getConversationTitle("CONV1", "CU1") } returns "Weekly Report Format"
        coEvery { conversations.getConversationTitle("GONE", "CU1") } throws ConversationAccessDeniedException("not found")

        val page = service.getUsagePage("CU1", "MEM#1", 25, null)

        assertEquals(198, page.total)
        assertEquals("next", page.nextCursor)
        assertEquals(listOf("Weekly Report Format", "Weekly Report Format", null), page.items.map { it.conversationTitle })
        assertFalse(page.items.last().conversationAvailable)
        coVerify(exactly = 1) { conversations.getConversationTitle("CONV1", "CU1") }
    }

    // ── How a memory was inferred ───────────────────────────────────────────

    private fun inferenceMessage(id: String, customer: String, role: String, text: String, vendor: String? = null) = Message(
        messageId = id, conversationId = "CONV1", text = text, client = "test", role = role, customerId = customer,
        systemPrompt = "", previousMessageId = null,
        aiConfig = listOfNotNull(vendor?.let { com.genflowly.models.AIConfig(com.genflowly.models.AIVendor(it), "m") })
    )

    private fun inferenceRun() = com.genflowly.models.api.MemoryRun(
        runId = "RUN1", source = "conversation", conversationId = "CONV1", turnMessageId = "U3",
        messageIds = listOf("U1", "U3", "R-openai", "R-claude"),
        responsesRead = listOf(
            com.genflowly.models.api.MemoryRunResponse("R-openai", "OPENAI", "gpt-5.4"),
            com.genflowly.models.api.MemoryRunResponse("R-claude", "CLAUDE", "claude-fable-5-1"),
        ),
        existingShown = 12, vendor = "OPENAI", model = "gpt-5.4", startedAt = "2026-11-22T14:32:00Z", durationMs = 4200,
        operations = listOf(
            com.genflowly.models.api.MemoryRunOperation("ADD", "MEM#1", "Prefers short answers.", "Says so", 2, "applied")
        ),
    )

    @Test
    fun `the inference quotes what the agent read, marks the line it took, and leaves out other people's words`() = runTest {
        stored(memory(profileCore))
        coEvery { memoryRepo.getRun("CU1", "RUN1") } returns inferenceRun()
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns listOf(
            MemoryChange(
                changeId = "MEMCHG#1", type = MemoryChangeType.LEARNED, createdAt = "t", version = 1,
                text = "Prefers short answers.", conversationId = "CONV1", messageId = "U3", reason = "Says so", runId = "RUN1"
            )
        )
        coEvery { conversations.getConversationTitle("CONV1", "CU1") } returns "Weekly Report Format"
        coEvery { conversations.getMessage("CONV1", "U1") } returns inferenceMessage("U1", "CU-other", "user", "Someone else.")
        coEvery { conversations.getMessage("CONV1", "U3") } returns inferenceMessage("U3", "CU1", "user", "Keep answers short.")
        coEvery { conversations.getMessage("CONV1", "R-openai") } returns inferenceMessage("R-openai", "CU1", "assistant", "Sure.", "OPENAI")
        coEvery { conversations.getMessage("CONV1", "R-claude") } returns inferenceMessage("R-claude", "CU1", "assistant", "Got it.", "CLAUDE")

        coEvery { memoryRepo.getMemories("CU1") } returns listOf(memory(profileCore))

        val inference = service.getInference("CU1", "MEM#1", "RUN1")

        assertEquals("RUN1", inference.change?.runId)
        assertFalse(inference.run.operations.single().memoryDeleted)
        assertEquals(listOf("U3", "R-openai", "R-claude"), inference.excerpts.map { it.messageId })
        assertEquals(listOf(true, false, false), inference.excerpts.map { it.taken })
        assertEquals(listOf(null, "OPENAI", "CLAUDE"), inference.excerpts.map { it.vendor })
        assertEquals(2, inference.excerpts.first().index)
        assertEquals("Weekly Report Format", inference.conversationTitle)
        assertFalse(inference.conversationDeleted)
    }

    @Test
    fun `a deleted conversation leaves the run without excerpts`() = runTest {
        stored(memory(profileCore))
        coEvery { memoryRepo.getRun("CU1", "RUN1") } returns inferenceRun()
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns emptyList()
        coEvery { conversations.getConversationTitle("CONV1", "CU1") } throws ConversationAccessDeniedException("not found")
        coEvery { memoryRepo.getMemories("CU1") } returns listOf(memory(profileCore))

        val inference = service.getInference("CU1", "MEM#1", "RUN1")

        assertTrue(inference.conversationDeleted)
        assertTrue(inference.excerpts.isEmpty())
        assertEquals(4200, inference.run.durationMs)
    }

    @Test
    fun `an unknown run, or a run that never touched the memory, is not found`() = runTest {
        stored(memory(profileCore))
        coEvery { memoryRepo.getRun("CU1", "NOPE") } returns null
        coEvery { memoryRepo.getRun("CU1", "OTHER") } returns inferenceRun().copy(operations = emptyList())
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns emptyList()

        assertFailsWith<MemoryNotFoundException> { service.getInference("CU1", "MEM#1", "NOPE") }
        assertFailsWith<MemoryNotFoundException> { service.getInference("CU1", "MEM#1", "OTHER") }
    }

    @Test
    fun `quotes are plain text, never markdown`() {
        val reply = "My recommendation: **learn Rive next** (and keep *Lottie*).\n\n### Why Rive first\n- **Interactive**: states\n1. Ship `rive-ios` [docs](https://rive.app)\n> quoted"
        assertEquals(
            "My recommendation: learn Rive next (and keep Lottie). Why Rive first Interactive: states Ship rive-ios docs quoted",
            plainQuote(reply)
        )
        assertEquals("2 * 3 = 6", plainQuote("2 * 3 = 6"))
    }

    @Test
    fun `deleting a memory takes it out of the replies that listed it`() = runTest {
        stored(memory(profileCore))
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns listOf(
            MemoryChange(changeId = "c1", type = MemoryChangeType.LEARNED, createdAt = "t", conversationId = "CONV1"),
            MemoryChange(changeId = "c2", type = MemoryChangeType.UPDATED, createdAt = "t", conversationId = "CONV1"),
            MemoryChange(changeId = "c3", type = MemoryChangeType.EDITED_BY_YOU, createdAt = "t"),
        )
        coEvery { memoryRepo.deleteMemory("CU1", "MEM#1") } returns true
        coEvery { conversations.removeLearnedFact("CONV1", "MEM#1") } returns 2

        assertTrue(service.deleteMemory("CU1", "MEM#1"))

        coVerify(timeout = 2000, exactly = 1) { conversations.removeLearnedFact("CONV1", "MEM#1") }
    }

    @Test
    fun `deleting a memory keeps its runs but drops its words from them`() = runTest {
        stored(memory(profileCore))
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns listOf(
            MemoryChange(changeId = "c1", type = MemoryChangeType.LEARNED, createdAt = "t", conversationId = "CONV1", runId = "RUN1"),
        )
        coEvery { memoryRepo.deleteMemory("CU1", "MEM#1") } returns true
        coEvery { conversations.removeLearnedFact("CONV1", "MEM#1") } returns 1
        coEvery { memoryRepo.getRun("CU1", "RUN1") } returns inferenceRun().copy(
            operations = listOf(
                com.genflowly.models.api.MemoryRunOperation("ADD", "MEM#1", "Prefers short answers.", "Says so", 2, "applied"),
                com.genflowly.models.api.MemoryRunOperation("ADD", "MEM#2", "Uses a MacBook.", "Mentions it", 2, "applied"),
            )
        )
        val written = slot<com.genflowly.models.api.MemoryRun>()
        coEvery { memoryRepo.putRun("CU1", capture(written)) } returns Unit

        assertTrue(service.deleteMemory("CU1", "MEM#1"))

        coVerify(timeout = 2000, exactly = 1) { memoryRepo.putRun("CU1", any()) }
        val (gone, kept) = written.captured.operations
        assertEquals(null, gone.text)
        assertEquals(null, gone.reason)
        assertEquals("MEM#1", gone.memoryId)
        assertEquals("Uses a MacBook.", kept.text)
        assertEquals("Mentions it", kept.reason)
    }

    @Test
    fun `operations whose memory was deleted since say so`() = runTest {
        stored(memory(profileCore))
        coEvery { memoryRepo.getRun("CU1", "RUN1") } returns inferenceRun().copy(
            operations = listOf(
                com.genflowly.models.api.MemoryRunOperation("ADD", "MEM#1", "Prefers short answers.", "Says so", 2, "applied"),
                com.genflowly.models.api.MemoryRunOperation("ADD", "MEM#gone", "Uses a MacBook.", "Says so", 2, "applied"),
                com.genflowly.models.api.MemoryRunOperation("DELETE", "MEM#old", null, "Obsolete", 2, "applied"),
            )
        )
        coEvery { memoryRepo.getChanges("CU1", "MEM#1") } returns emptyList()
        coEvery { memoryRepo.getMemories("CU1") } returns listOf(memory(profileCore))
        coEvery { conversations.getConversationTitle("CONV1", "CU1") } throws ConversationAccessDeniedException("not found")

        val ops = service.getInference("CU1", "MEM#1", "RUN1").run.operations

        assertEquals(listOf(false, true, false), ops.map { it.memoryDeleted })
        assertEquals(listOf("Prefers short answers.", null, null), ops.map { it.text })
        assertEquals(listOf("Says so", null, "Obsolete"), ops.map { it.reason })
    }
}
