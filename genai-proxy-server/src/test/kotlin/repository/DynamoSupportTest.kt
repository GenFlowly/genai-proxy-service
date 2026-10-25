package com.genflowly.repository

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DynamoSupportTest {

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    @Test
    fun `preferredModels round-trip keeps thinkingLevel and maxTokens`() {
        val configs = listOf(
            AIConfig(aiVendor = AIVendor.OPENAI, model = "gpt-5", thinkingLevel = "high"),
            AIConfig(aiVendor = AIVendor.CLAUDE, model = "claude-fable-5", maxTokens = 4096),
            AIConfig(aiVendor = AIVendor.GEMINI, model = "gemini-3-pro")
        )

        val roundTripped = attributeValueToAiConfig(aiConfigToAttributeValue(configs))

        assertEquals(configs, roundTripped)
    }

    @Test
    fun `blank thinkingLevel is not stored`() {
        val stored = aiConfigToAttributeValue(
            listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "gpt-5", thinkingLevel = " "))
        )

        assertNull(stored.l().single().m()["thinkingLevel"])
        assertNull(attributeValueToAiConfig(stored).single().thinkingLevel)
    }

    @Test
    fun `legacy items without thinkingLevel still deserialize`() {
        val legacy = AttributeValue.builder()
            .l(
                AttributeValue.builder()
                    .m(mapOf("aiVendor" to s("OPENAI"), "model" to s("gpt-5")))
                    .build()
            )
            .build()

        val parsed = attributeValueToAiConfig(legacy).single()

        assertEquals(AIVendor.OPENAI, parsed.aiVendor)
        assertEquals("gpt-5", parsed.model)
        assertNull(parsed.thinkingLevel)
        assertNull(parsed.maxTokens)
    }
}
