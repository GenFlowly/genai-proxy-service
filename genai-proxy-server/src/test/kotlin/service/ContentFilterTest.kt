package com.genflowly.service

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ContentFilterTest {
    private val filter = ContentFilter(listOf("shit", "ass", "fuck", "two girls one cup", "g-spot", "2g1c"))

    @Test
    fun `clean text passes`() {
        assertTrue(filter.isAllowed("Here is the launch checklist with owners and dates."))
        assertTrue(filter.isAllowed(""))
    }

    @Test
    fun `listed word is caught whatever the case or punctuation around it`() {
        assertEquals("shit", filter.firstMatch("well, SHIT."))
        assertEquals("shit", filter.firstMatch("(shit)"))
        assertEquals("shit", filter.firstMatch("oh shit!"))
    }

    @Test
    fun `whole words only`() {
        assertNull(filter.firstMatch("Please assess the classic passage"))
        assertNull(filter.firstMatch("shitake"))
    }

    @Test
    fun `letter swaps are caught`() {
        assertEquals("shit", filter.firstMatch("sh1t"))
        assertEquals("shit", filter.firstMatch("sh!t"))
        assertEquals("ass", filter.firstMatch("a\$\$"))
        assertEquals("fuck", filter.firstMatch("fück"))
    }

    @Test
    fun `stretched letters are caught`() {
        assertEquals("shit", filter.firstMatch("shiiiiit"))
        assertEquals("fuck", filter.firstMatch("fuuuuck"))
        assertEquals("ass", filter.firstMatch("asssss"))
    }

    @Test
    fun `spelled out words are caught`() {
        assertEquals("shit", filter.firstMatch("s.h.i.t"))
        assertEquals("fuck", filter.firstMatch("f u c k this"))
    }

    @Test
    fun `invisible characters don't hide a word`() {
        assertEquals("shit", filter.firstMatch("sh​it"))
    }

    @Test
    fun `phrases match as consecutive words`() {
        assertEquals("two girls one cup", filter.firstMatch("watch two girls one cup now"))
        assertNull(filter.firstMatch("two girls and one cup"))
        assertEquals("g spot", filter.firstMatch("the g-spot"))
    }

    @Test
    fun `numbers are left alone unless a term contains them`() {
        assertNull(filter.firstMatch("In 2023 we shipped 45 builds at \$100"))
        assertNotNull(filter.firstMatch("2g1c"))
    }

    @Test
    fun `the shipped word list loads and leaves everyday words alone`() {
        val shipped = ContentFilter.fromResource()
        assertFalse(shipped.isAllowed("this is bullshit"))
        listOf(
            "graduated magna cum laude from Scunthorpe",
            "how to kill a process on macOS",
            "Moby Dick and the Ford Escort",
            "assess the XXX-XX placeholder and the blood test results",
            "tied up in meetings, suck it up"
        ).forEach { assertTrue(shipped.isAllowed(it), it) }
    }
}
