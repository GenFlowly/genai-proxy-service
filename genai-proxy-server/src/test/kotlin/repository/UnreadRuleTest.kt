package com.genflowly.repository

import com.genflowly.DynamoDBConstants.LAST_READ_AT_KEY
import com.genflowly.DynamoDBConstants.LAST_REPLY_AT_KEY
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** A conversation is unread when a reply was saved after its owner last read it. */
class UnreadRuleTest {

    private fun row(replied: String?, read: String?): Map<String, AttributeValue> = buildMap {
        replied?.let { put(LAST_REPLY_AT_KEY, AttributeValue.builder().s(it).build()) }
        read?.let { put(LAST_READ_AT_KEY, AttributeValue.builder().s(it).build()) }
    }

    @Test
    fun `a reply after the last read is unread`() {
        assertTrue(isUnread(row(replied = "2026-11-27T10:00:05Z", read = "2026-11-27T10:00:01Z")))
    }

    @Test
    fun `a read after the reply clears it`() {
        assertFalse(isUnread(row(replied = "2026-11-27T10:00:05Z", read = "2026-11-27T10:00:06Z")))
    }

    @Test
    fun `instants compare as times, not strings`() {
        // Instant.toString drops trailing zeros: "…:01Z" sorts after "…:01.5Z" as text.
        assertTrue(isUnread(row(replied = "2026-11-27T10:00:01.5Z", read = "2026-11-27T10:00:01Z")))
        assertFalse(isUnread(row(replied = "2026-11-27T10:00:01Z", read = "2026-11-27T10:00:01.5Z")))
    }

    @Test
    fun `rows from before the stamps, or never read, show no dot`() {
        assertFalse(isUnread(row(replied = null, read = null)))
        assertFalse(isUnread(row(replied = "2026-11-27T10:00:05Z", read = null)))
        assertFalse(isUnread(null))
    }
}
