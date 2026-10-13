package com.genflowly.service

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The math-delimiter guidance exists because the component-library markdown
 * renderer (TextContainer) parses \( .. \) / \[ .. \] but deliberately not
 * single-dollar $..$ math. It must reach exactly the turns those UIs render:
 * our own UI clients, and never structured-output turns, developer API-key
 * traffic or internal utility generations.
 */
class ResponseFormattingTest {

    private val guidance = ResponseFormatting.MATH_FORMATTING_GUIDANCE

    @Test
    fun `UI clients get the guidance appended after the instruction`() {
        for (client in listOf("REACT_APP", "ADMIN_PANEL")) {
            assertEquals(
                "be kind\n\n$guidance",
                ResponseFormatting.decorateSystemPrompt("be kind", client, structuredOutput = false),
                "client $client"
            )
        }
    }

    @Test
    fun `turn without an instruction gets the guidance alone`() {
        assertEquals(
            guidance,
            ResponseFormatting.decorateSystemPrompt("", "REACT_APP", structuredOutput = false)
        )
    }

    @Test
    fun `non-UI clients are never altered`() {
        for (client in listOf("internal", "memory", "my-integration", "")) {
            assertEquals(
                "be kind",
                ResponseFormatting.decorateSystemPrompt("be kind", client, structuredOutput = false),
                "client $client"
            )
        }
    }

    @Test
    fun `structured-output turns are never altered`() {
        assertEquals(
            "be kind",
            ResponseFormatting.decorateSystemPrompt("be kind", "REACT_APP", structuredOutput = true)
        )
        assertEquals(
            "",
            ResponseFormatting.decorateSystemPrompt("", "REACT_APP", structuredOutput = true)
        )
    }

    @Test
    fun `guidance mandates the TeX delimiters the renderer parses and bans dollar delimiters`() {
        assertTrue(guidance.contains("\\( ... \\)"), "must name the inline delimiter")
        assertTrue(guidance.contains("\\[ ... \\]"), "must name the display delimiter")
        assertTrue(guidance.contains("$"), "must address the dollar convention it replaces")
    }
}
