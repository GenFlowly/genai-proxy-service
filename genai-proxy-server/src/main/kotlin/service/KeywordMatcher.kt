package com.genflowly.service

/**
 * Plain keyword matching for records not (yet) in the vector DB: a record
 * matches when every query word appears in its text, case-insensitively.
 */
class KeywordMatcher(query: String) {
    private val terms: List<String> = query.lowercase().split(WHITESPACE).filter { it.isNotBlank() }.distinct()

    val isEmpty: Boolean get() = terms.isEmpty()

    fun matches(vararg texts: String?): Boolean {
        if (terms.isEmpty()) return false
        val haystack = texts.filterNotNull().joinToString("\n").lowercase()
        return terms.all { haystack.contains(it) }
    }

    /** Up to [SNIPPET_CHARS] of [text] around the first query word in it. */
    fun snippet(text: String): String {
        val clean = text.replace(WHITESPACE, " ").trim()
        if (clean.length <= SNIPPET_CHARS) return clean
        val lower = clean.lowercase()
        val hit = terms.mapNotNull { term -> lower.indexOf(term).takeIf { it >= 0 } }.minOrNull() ?: 0
        val start = (hit - SNIPPET_CHARS / 3).coerceIn(0, clean.length - SNIPPET_CHARS)
        val body = clean.substring(start, start + SNIPPET_CHARS).trim()
        return (if (start > 0) "…" else "") + body + (if (start + SNIPPET_CHARS < clean.length) "…" else "")
    }

    companion object {
        private val WHITESPACE = Regex("\\s+")
        private const val SNIPPET_CHARS = 200

        /**
         * Keyword matches first, up to half of [limit] (they contain the
         * literal query words, and the vector search always fills its top N,
         * so appended keyword results would never show); semantic hits fill
         * the rest, and leftover keyword matches any space still free. A record
         * found both ways appears once, as its semantic hit.
         */
        fun <T> mergeKeywordFirst(semantic: List<T>, keyword: List<T>, limit: Int, key: (T) -> Any): List<T> {
            val semanticKeys = semantic.map(key).toSet()
            val fresh = keyword.filter { key(it) !in semanticKeys }
            val keywordFirst = minOf(fresh.size, (limit + 1) / 2)
            val semanticTake = minOf(semantic.size, limit - keywordFirst)
            val keywordAfter = limit - keywordFirst - semanticTake
            return fresh.take(keywordFirst) + semantic.take(semanticTake) + fresh.drop(keywordFirst).take(keywordAfter)
        }
    }
}
