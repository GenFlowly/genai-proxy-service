package com.genflowly.models

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * An AI vendor/provider id. Historically a closed enum (OPENAI/CLAUDE/GEMINI);
 * now an open value class so customers can bring a key for any provider the
 * retrieval server can call (its /providers catalog — LiteLLM provider ids).
 *
 * Canonical names: the legacy three keep their uppercase enum names — that is
 * their API wire format AND their DynamoDB vendor key, so it must never
 * change. Every other vendor uses its lowercase LiteLLM provider id (e.g.
 * "groq", "xai", "together_ai") in both places. [of] normalizes input to
 * these canonical forms; mappings to retrieval-server identifiers live in
 * AIVendorMappings.kt.
 */
@Serializable(with = AIVendorSerializer::class)
@JvmInline
value class AIVendor(val name: String) {
    override fun toString(): String = name

    companion object {
        val OPENAI = AIVendor("OPENAI")
        val CLAUDE = AIVendor("CLAUDE")
        val GEMINI = AIVendor("GEMINI")

        /**
         * The first-class vendors that existed as the original enum. Various
         * flows still enumerate exactly these (key-row seeding, model
         * prefetch); long-tail vendors appear only once a key is stored.
         */
        val entries: List<AIVendor> = listOf(OPENAI, CLAUDE, GEMINI)

        // Rows in CustomerVendorApiKeys that are NOT text-generation vendors
        // (the VOYAGE embedding key, the HUGGINGFACE Hub token) — AI-vendor
        // readers must keep skipping them.
        private val EMBEDDING_ONLY_NAMES = setOf("VOYAGE", "HUGGINGFACE")

        /**
         * Normalizes any spelling of a vendor to its canonical form: legacy
         * names (and their provider-string synonyms) map to the uppercase
         * legacy constants, everything else lowercases to its LiteLLM id.
         */
        fun of(value: String): AIVendor = when (value.lowercase()) {
            "openai" -> OPENAI
            "claude", "anthropic" -> CLAUDE
            "gemini" -> GEMINI
            else -> AIVendor(value.lowercase())
        }

        /** Enum-era API compatibility: now accepts any provider id. */
        fun valueOf(value: String): AIVendor = of(value)

        /**
         * Parse a stored CustomerVendorApiKeys vendor key; null for rows that
         * are not text-generation vendors (e.g. the VOYAGE embedding key).
         */
        fun fromStoredNameOrNull(value: String): AIVendor? =
            if (value.uppercase() in EMBEDDING_ONLY_NAMES) null else of(value)
    }
}

object AIVendorSerializer : KSerializer<AIVendor> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("AIVendor", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: AIVendor) = encoder.encodeString(value.name)

    override fun deserialize(decoder: Decoder): AIVendor = AIVendor.of(decoder.decodeString())
}
