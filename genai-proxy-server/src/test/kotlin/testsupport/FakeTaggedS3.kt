package com.genflowly.testsupport

import com.genflowly.models.AttachmentObjectInfo
import com.genflowly.providers.S3Provider
import io.mockk.coEvery
import io.mockk.mockk
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import java.util.Collections

/**
 * An in-memory attachments bucket behind a mocked [S3Provider]: objects with
 * their tag sets, copies, listing and batch deletes, plus a call log. Keys in
 * [failingKeys] throw on every tagging/copy call (a transient S3 failure that
 * never recovers); keys in [failOnce] throw on their first tagging write only.
 */
class FakeTaggedS3 {
    val objects: MutableMap<String, MutableMap<String, String>> = Collections.synchronizedMap(linkedMapOf())
    val calls: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val failingKeys: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())
    val failOnce: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())
    /** Keys a deleteObjects call reports as still failing. */
    val undeletable: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())

    val provider: S3Provider = mockk()

    fun put(key: String, vararg tags: Pair<String, String>) {
        objects[key] = mutableMapOf(*tags)
    }

    fun tags(key: String): Map<String, String>? = objects[key]?.toMap()

    private fun missing(key: String) = NoSuchKeyException.builder().message("NoSuchKey: $key").build()

    private fun transient(key: String) = RuntimeException("S3 is unavailable for $key")

    init {
        coEvery { provider.getObjectTagging(any()) } answers {
            val key = firstArg<String>()
            calls += "getTagging:$key"
            if (key in failingKeys) throw transient(key)
            objects[key]?.toMap() ?: throw missing(key)
        }
        coEvery { provider.putObjectTagging(any(), any()) } answers {
            val key = firstArg<String>()
            calls += "putTagging:$key"
            if (key in failingKeys) throw transient(key)
            if (failOnce.remove(key)) throw transient(key)
            val existing = objects[key] ?: throw missing(key)
            existing.clear()
            existing.putAll(secondArg<Map<String, String>>())
            Unit
        }
        coEvery { provider.copyObject(any(), any(), any()) } answers {
            val src = firstArg<String>()
            val dst = secondArg<String>()
            calls += "copy:$src->$dst"
            if (src in failingKeys) throw transient(src)
            val source = objects[src] ?: throw missing(src)
            objects[dst] = (thirdArg<Map<String, String>?>() ?: source).toMutableMap()
            Unit
        }
        coEvery { provider.head(any()) } answers {
            val key = firstArg<String>()
            calls += "head:$key"
            if (objects.containsKey(key)) AttachmentObjectInfo(1, "application/octet-stream") else null
        }
        coEvery { provider.listKeys(any()) } answers {
            val prefix = firstArg<String>()
            calls += "list:$prefix"
            synchronized(objects) { objects.keys.filter { it.startsWith(prefix) } }
        }
        coEvery { provider.deleteObjects(any()) } answers {
            val keys = firstArg<Collection<String>>()
            calls += "delete:${keys.size}"
            val failed = keys.filter { it in undeletable }
            keys.filterNot { it in undeletable }.forEach { objects.remove(it) }
            failed
        }
    }
}
