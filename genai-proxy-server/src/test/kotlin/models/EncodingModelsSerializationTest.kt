package com.genflowly.models

import com.genflowly.di.provideJson
import com.genflowly.models.encoding.EncodingConversationData
import com.genflowly.models.encoding.EncodingMemoryData
import com.genflowly.models.encoding.EncodingSaveConversationRequest
import com.genflowly.models.encoding.EncodingSaveMemoryRequest
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The shared ingest lambda routes payloads by dataType and falls back to NOTE
 * when the field is absent — which note-validates (and 400s) conversation and
 * memory payloads. These tests pin that the defaulted dataType fields survive
 * serialization with the app's actual Json configuration.
 */
class EncodingModelsSerializationTest {

    private val json = provideJson()

    @Test
    fun `conversation payload carries its dataType on the wire`() {
        val payload = json.encodeToString(
            EncodingSaveConversationRequest(
                client = "REACT_APP",
                data = EncodingConversationData(
                    conversation_key = "c1", conversationKey = "c1",
                    message_key = "m1", messageKey = "m1",
                    text = "User: hi\nAssistant: hello",
                    title = "greeting",
                    created_at = "2026-01-01T00:00:00Z", createdAt = "2026-01-01T00:00:00Z"
                )
            )
        )
        assertTrue("\"dataType\":\"CONVERSATION\"" in payload, payload)
    }

    @Test
    fun `memory payload carries its dataType on the wire`() {
        val payload = json.encodeToString(
            EncodingSaveMemoryRequest(
                client = "memory",
                data = EncodingMemoryData(
                    memory_key = "k1", memoryKey = "k1",
                    memory_value = "prefers Kotlin", memoryValue = "prefers Kotlin",
                    title = "[memory] preference",
                    created_at = "2026-01-01T00:00:00Z", createdAt = "2026-01-01T00:00:00Z"
                )
            )
        )
        assertTrue("\"dataType\":\"MEMORY\"" in payload, payload)
    }
}
