package com.genflowly.service

import com.genflowly.models.AttachmentRef
import com.genflowly.testsupport.FakeTaggedS3
import io.mockk.coEvery
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 1.16: every key a stored message links to is tagged kept for its
 * conversation; a key another conversation keeps is copied, never re-tagged;
 * failures leave the claim incomplete for the reconciler.
 */
class ObjectClaimServiceTest {

    private val s3 = FakeTaggedS3()
    private val service = ObjectClaimService(s3.provider, retryBaseDelayMs = 1)
    private val conv = "conv-1"
    private val kept = mapOf("retention" to "kept", "conv" to conv)

    private fun key(id: String, customer: String = "c1") = "customers/$customer/attachments/$id"
    private fun ref(id: String, customer: String = "c1", sourceKey: String? = null) =
        AttachmentRef(attachmentId = id, s3Key = key(id, customer), mediaType = "application/pdf", sourceKey = sourceKey)

    private fun toolJson(vararg keys: String) =
        """[{"tool_call_id":"t1","content":"","images":[""" +
            keys.joinToString(",") { """{"s3_key":"$it","media_type":"image/png"}""" } + "]}]"

    @Test
    fun `uploads, sources and tool-result images are tagged kept for the conversation`() = runTest {
        s3.put(key("img"), "retention" to "pending")
        s3.put(key("pdf"), "retention" to "pending")
        s3.put(key("pdf") + ".source.md", "retention" to "pending")
        s3.put(key("shot"))

        val outcome = service.claim(
            conv, "m1", "assistant",
            listOf(ref("img"), ref("pdf", sourceKey = key("pdf") + ".source.md")),
            toolJson(key("shot"))
        )

        assertTrue(outcome.complete)
        for (k in listOf(key("img"), key("pdf"), key("pdf") + ".source.md", key("shot"))) {
            assertEquals(kept, s3.tags(k), k)
        }
        assertEquals(setOf(key("img"), key("pdf"), key("pdf") + ".source.md", key("shot")), outcome.newlyClaimed)
        assertTrue(outcome.copies.isEmpty())
    }

    @Test
    fun `a legacy generated file's sidecar is claimed only when it exists`() = runTest {
        s3.put(key("old"), "retention" to "pending")
        s3.put(key("old") + ".source.md", "retention" to "pending")
        s3.put(key("older"), "retention" to "pending") // no sidecar

        val outcome = service.claim(conv, "m1", "assistant", listOf(ref("old"), ref("older")), null)

        assertTrue(outcome.complete)
        assertEquals(kept, s3.tags(key("old") + ".source.md"))
        assertNull(s3.tags(key("older") + ".source.md"))
        assertFalse(key("older") + ".source.md" in outcome.newlyClaimed)
    }

    @Test
    fun `a key already kept here is left alone`() = runTest {
        s3.put(key("img"), "retention" to "kept", "conv" to conv)

        val outcome = service.claim(conv, "m1", "user", listOf(ref("img")), null)

        assertTrue(outcome.complete)
        assertTrue(outcome.newlyClaimed.isEmpty())
        assertFalse(s3.calls.any { it.startsWith("putTagging") })
    }

    @Test
    fun `a key kept by another conversation is copied with its sidecar and the ref rewritten`() = runTest {
        val otherTags = mapOf("retention" to "kept", "conv" to "conv-other")
        s3.put(key("pdf"), *otherTags.toList().toTypedArray())
        s3.put(key("pdf") + ".source.md", *otherTags.toList().toTypedArray())

        val outcome = service.claim(
            conv, "m1", "assistant", listOf(ref("pdf", sourceKey = key("pdf") + ".source.md")), null
        )

        assertTrue(outcome.complete)
        val copy = outcome.attachments.single()
        assertNotEquals(key("pdf"), copy.s3Key)
        assertTrue(copy.s3Key.startsWith("customers/c1/attachments/"), copy.s3Key)
        assertEquals(copy.s3Key + ".source.md", copy.sourceKey)
        assertEquals("pdf", copy.attachmentId) // the id the client knows stays
        // The other conversation keeps its objects untouched; the copies are this conversation's
        assertEquals(otherTags, s3.tags(key("pdf")))
        assertEquals(otherTags, s3.tags(key("pdf") + ".source.md"))
        assertEquals(kept, s3.tags(copy.s3Key))
        assertEquals(kept, s3.tags(copy.sourceKey!!))
        assertEquals(setOf(copy.s3Key, copy.sourceKey!!), outcome.newlyClaimed)

        // The same claim retried (or reconciled later) reuses the same copy key
        val again = service.claim(conv, "m1", "assistant", listOf(ref("pdf", sourceKey = key("pdf") + ".source.md")), null)
        assertEquals(copy.s3Key, again.attachments.single().s3Key)
    }

    @Test
    fun `a tool-result image kept elsewhere is copied and its key rewritten in the JSON`() = runTest {
        s3.put(key("shot", "c2"), "retention" to "kept", "conv" to "conv-other")

        val outcome = service.claim(conv, "m1", "user", emptyList(), toolJson(key("shot", "c2")))

        val newKey = RetentionKeys.toolResultImageKeys(outcome.toolResultsJson).single()
        assertTrue(newKey.startsWith("customers/c2/attachments/") && newKey != key("shot", "c2"), newKey)
        assertEquals(kept, s3.tags(newKey))
        assertEquals(mapOf(key("shot", "c2") to newKey), outcome.copies)
    }

    @Test
    fun `a malformed key is skipped without any S3 call`() = runTest {
        val outcome = service.claim(
            conv, "m1", "user",
            listOf(AttachmentRef("bad", "customers/c1/other/bad", "image/png")),
            toolJson("not/a/customer/key")
        )
        assertTrue(outcome.complete)
        assertTrue(s3.calls.isEmpty(), s3.calls.toString())
    }

    @Test
    fun `a missing object is nothing to keep, not a failure`() = runTest {
        val outcome = service.claim(conv, "m1", "user", listOf(ref("gone")), null)
        assertTrue(outcome.complete)
        assertTrue(outcome.newlyClaimed.isEmpty())
    }

    @Test
    fun `a failing key is retried, then leaves the claim incomplete while the others are claimed`() = runTest {
        s3.put(key("ok"), "retention" to "pending")
        s3.put(key("bad"), "retention" to "pending")
        s3.failingKeys += key("bad")

        val outcome = service.claim(conv, "m1", "user", listOf(ref("ok"), ref("bad")), null)

        assertFalse(outcome.complete)
        assertEquals(kept, s3.tags(key("ok")))
        assertEquals(mapOf("retention" to "pending"), s3.tags(key("bad")))
        assertEquals(ObjectClaimService.DEFAULT_MAX_ATTEMPTS, s3.calls.count { it == "getTagging:${key("bad")}" })
    }

    @Test
    fun `a transient failure that clears on retry completes the claim`() = runTest {
        s3.put(key("flaky"), "retention" to "pending")
        s3.failOnce += key("flaky")

        val outcome = service.claim(conv, "m1", "user", listOf(ref("flaky")), null)

        assertTrue(outcome.complete)
        assertEquals(kept, s3.tags(key("flaky")))
    }

    @Test
    fun `claims run in parallel with bounded concurrency`() = runTest {
        val inFlight = AtomicInteger()
        val peak = AtomicInteger()
        val refs = (1..30).map { ref("a$it") }
        refs.forEach { s3.put(it.s3Key) }
        coEvery { s3.provider.getObjectTagging(any()) } coAnswers {
            peak.accumulateAndGet(inFlight.incrementAndGet(), ::maxOf)
            delay(10)
            inFlight.decrementAndGet()
            emptyMap()
        }
        val bounded = ObjectClaimService(s3.provider, maxConcurrency = 4, retryBaseDelayMs = 1)

        assertTrue(bounded.claim(conv, "m1", "user", refs, null).complete)
        assertTrue(peak.get() in 2..4, "peak concurrency ${peak.get()}")
    }

    @Test
    fun `released keys are re-tagged pending and missing ones are ignored`() = runTest {
        s3.put(key("a"), "retention" to "kept", "conv" to conv)

        val failures = service.releaseToPending(listOf(key("a"), key("gone"), "not/a/key"))

        assertEquals(0, failures)
        assertEquals(mapOf("retention" to "pending"), s3.tags(key("a")))
    }
}
