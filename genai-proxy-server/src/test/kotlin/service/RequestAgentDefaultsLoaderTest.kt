package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgentSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Loads the REAL bundled config/request-agent-defaults.json, guarding the
 * fallback path every internal generation flow depends on until the admin
 * panel seeds DDB entries.
 */
class RequestAgentDefaultsLoaderTest {

    private val defaults = RequestAgentDefaultsLoader().defaults

    @Test
    fun `covers every request type`() {
        RequestType.entries.forEach { rt ->
            val agent = assertNotNull(defaults[rt], "missing default for $rt")
            assertEquals(ResolvedAgentSource.CONFIG, agent.source)
        }
    }

    @Test
    fun `persona default carries the JSON contract and category placeholder`() {
        val persona = defaults.getValue(RequestType.INSTRUCTION_PERSONA)
        assertEquals("InstructionRequestDefault", persona.mapKey)
        assertEquals(AgentOutputFormat.JSON, persona.outputFormat)
        assertNull(persona.modelPreference) // system-failover configs pick the model
        assertTrue(persona.systemPromptTemplate.contains("{{categoryJson}}"))
        listOf("\"name\"", "\"icon\"", "\"color\"", "\"category\"", "\"tags\"").forEach {
            assertTrue(persona.systemPromptTemplate.contains(it), "persona prompt lost the $it key rule")
        }
        assertEquals("{{instructionText}}", persona.userMessageTemplate)
    }

    @Test
    fun `title defaults keep their placeholders and model preference`() {
        val convTitle = defaults.getValue(RequestType.CONVERSATION_TITLE)
        assertTrue(convTitle.userMessageTemplate.contains("{{instructionName}}"))
        assertTrue(convTitle.userMessageTemplate.contains("{{prompt}}"))
        assertEquals("", convTitle.systemPromptTemplate)
        assertEquals(AIVendor.OPENAI, convTitle.modelPreference?.aiVendor)
        assertEquals("gpt-5", convTitle.modelPreference?.model)

        val noteTitle = defaults.getValue(RequestType.NOTE_TITLE)
        assertEquals("{{noteContent}}", noteTitle.userMessageTemplate)
        assertTrue(noteTitle.systemPromptTemplate.contains("at most 8 words"))
        assertEquals(AIVendor.OPENAI, noteTitle.modelPreference?.aiVendor)
        assertEquals("gpt-5", noteTitle.modelPreference?.model)
    }
}
