package com.genflowly

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Guards the save-time embedding-model gate: the Settings picker (LiteLLM
 * catalog) is broader than what the encoding pipeline can encode, so the
 * platform must reject the extras before they're stored and fail silently deep
 * in create-embeddings.
 */
class EmbeddingModelSupportTest {

    @Test
    fun `accepts voyage text-embedding models the SDK supports`() {
        assertTrue(EmbeddingModelSupport.isSupported("voyage-4-large"))
        assertTrue(EmbeddingModelSupport.isSupported("voyage-3.5"))
        assertTrue(EmbeddingModelSupport.isSupported("voyage-code-3"))
    }

    @Test
    fun `accepts voyage contextualized and openai models`() {
        assertTrue(EmbeddingModelSupport.isSupported("voyage-context-4"))
        assertTrue(EmbeddingModelSupport.isSupported("text-embedding-3-large"))
        assertTrue(EmbeddingModelSupport.isSupported("text-embedding-ada-002"))
    }

    @Test
    fun `rejects multimodal models the text embed path cannot encode`() {
        // The exact model that aborted every conversation Step Functions run.
        assertFalse(EmbeddingModelSupport.isSupported("voyage-multimodal-3.5"))
        assertFalse(EmbeddingModelSupport.isSupported("voyage-multimodal-3"))
    }

    @Test
    fun `rejects unknown or typo'd names`() {
        assertFalse(EmbeddingModelSupport.isSupported("voyage-9000"))
        assertFalse(EmbeddingModelSupport.isSupported("gpt-4"))
        assertFalse(EmbeddingModelSupport.isSupported(""))
    }

    @Test
    fun `findUnsupported flags only set-and-invalid fields`() {
        val result = EmbeddingModelSupport.findUnsupported(
            "embeddingModel" to null,                              // unset -> skipped
            "embeddingModelConversations" to "voyage-multimodal-3.5", // invalid -> flagged
            "embeddingModelNotes" to "voyage-4-large",             // valid -> ok
        )
        assertEquals(listOf("embeddingModelConversations" to "voyage-multimodal-3.5"), result)
    }

    @Test
    fun `findUnsupported treats blank as unset`() {
        val result = EmbeddingModelSupport.findUnsupported(
            "embeddingModelConversations" to "",
            "embeddingModelNotes" to "   ",
        )
        assertTrue(result.isEmpty())
    }

    @Test
    fun `findUnsupported passes an all-valid set`() {
        val result = EmbeddingModelSupport.findUnsupported(
            "embeddingModel" to "voyage-4-large",
            "embeddingModelConversations" to "voyage-context-4",
            "embeddingModelNotes" to "text-embedding-3-small",
        )
        assertTrue(result.isEmpty())
    }
}
