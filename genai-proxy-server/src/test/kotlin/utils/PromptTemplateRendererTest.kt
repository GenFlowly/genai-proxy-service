package com.genflowly.utils

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class PromptTemplateRendererTest {

    @Test
    fun `substitutes placeholders`() {
        val out = PromptTemplateRenderer.render(
            "Hello {{name}}, welcome to {{place}}.",
            mapOf("name" to "Ada", "place" to "the lab")
        )
        assertEquals("Hello Ada, welcome to the lab.", out)
    }

    @Test
    fun `tolerates whitespace inside braces and repeated placeholders`() {
        val out = PromptTemplateRenderer.render(
            "{{ x }} and {{x}}",
            mapOf("x" to "1")
        )
        assertEquals("1 and 1", out)
    }

    @Test
    fun `fails loud on unresolved placeholder`() {
        val e = assertFailsWith<IllegalArgumentException> {
            PromptTemplateRenderer.render("Use {{categoryJson}} here", mapOf("other" to "v"))
        }
        assertTrue(e.message!!.contains("categoryJson"))
    }

    @Test
    fun `extra variables are ignored and template without placeholders passes through`() {
        val template = "No placeholders here. JSON braces like {\"a\": 1} are untouched."
        assertEquals(template, PromptTemplateRenderer.render(template, mapOf("unused" to "v")))
    }
}
