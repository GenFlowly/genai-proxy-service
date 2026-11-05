package com.genflowly.service

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KeywordMatcherTest {

    @Test
    fun `every query word must appear, in any case and any of the texts`() {
        val matcher = KeywordMatcher("Home  OFFICE")
        assertTrue(matcher.matches("Tax notes", "Deduct the home office"))
        assertTrue(matcher.matches(null, "office at home"))
        assertFalse(matcher.matches("Tax notes", "home only"))
    }

    @Test
    fun `a blank query matches nothing`() {
        val matcher = KeywordMatcher("   ")
        assertTrue(matcher.isEmpty)
        assertFalse(matcher.matches("anything"))
    }

    @Test
    fun `the snippet is the text around the first match`() {
        val text = "a ".repeat(300) + "the deduction rules " + "b ".repeat(300)
        val snippet = KeywordMatcher("deduction").snippet(text)
        assertTrue(snippet.contains("deduction"))
        assertTrue(snippet.startsWith("…") && snippet.endsWith("…"))
        assertTrue(snippet.length <= 202)
        assertEquals("short text", KeywordMatcher("text").snippet("short\n text"))
    }

    @Test
    fun `keyword matches go first up to half the limit, then semantic hits`() {
        val merged = KeywordMatcher.mergeKeywordFirst(
            semantic = listOf("s1", "s2", "s3", "s4"),
            keyword = listOf("k1", "k2", "k3"),
            limit = 4
        ) { it }
        assertEquals(listOf("k1", "k2", "s1", "s2"), merged)
    }

    @Test
    fun `leftover keyword matches fill space semantic hits leave`() {
        val merged = KeywordMatcher.mergeKeywordFirst(listOf("s1"), listOf("k1", "k2", "k3"), limit = 4) { it }
        assertEquals(listOf("k1", "k2", "s1", "k3"), merged)
    }

    @Test
    fun `a record found both ways appears once, as its semantic hit`() {
        val merged = KeywordMatcher.mergeKeywordFirst(
            semantic = listOf("a" to "semantic"),
            keyword = listOf("a" to "keyword", "b" to "keyword"),
            limit = 10
        ) { it.first }
        assertEquals(listOf("b" to "keyword", "a" to "semantic"), merged)
    }
}
