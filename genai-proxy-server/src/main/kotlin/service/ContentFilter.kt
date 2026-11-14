package com.genflowly.service

import java.text.Normalizer
import java.util.Locale

class ContentBlockedException(message: String) : Exception(message)

/**
 * Word-list check on content about to become visible to someone else. Text is
 * reduced to lower-case words before matching whole words and phrases, so
 * accents, punctuation, letter swaps (sh1t), spaced-out letters (s.h.i.t) and
 * stretched letters (shiiit) are caught while "assess" is not.
 */
class ContentFilter(terms: Collection<String>) {
    private val words: Set<String>
    private val phrasesByFirstWord: Map<String, List<List<String>>>

    init {
        val tokenized = terms.map(::plainTokens).filter { it.isNotEmpty() }
        words = tokenized.filter { it.size == 1 }.map { it.single() }.toSet()
        phrasesByFirstWord = tokenized.filter { it.size > 1 }.groupBy { it.first() }
    }

    /** The first listed term in [text], or null. It is a piece of the user's content: never send it to clients or write it to logs. */
    fun firstMatch(text: String): String? {
        val raw = RAW_TOKEN.findAll(normalize(text)).map { it.value }.toList()
        val plain = raw.map { it.trim('!') }
        val swapped = raw.map(::swapLetters)

        plain.forEachIndexed { index, token ->
            val candidates = sequenceOf(token, swapped[index]).flatMap(::withCollapsedRepeats)
            candidates.firstOrNull { it in words }?.let { return it }
            phrasesByFirstWord[token]?.forEach { phrase ->
                if (plain.drop(index).take(phrase.size) == phrase) return phrase.joinToString(" ")
            }
        }
        return spelledOutWords(plain).flatMap(::withCollapsedRepeats).firstOrNull { it in words }
    }

    fun isAllowed(text: String): Boolean = firstMatch(text) == null

    private fun plainTokens(text: String): List<String> =
        RAW_TOKEN.findAll(normalize(text)).map { it.value.trim('!') }.toList()

    private fun normalize(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFKD)
            .replace(IGNORED_CHARACTERS, "")
            .lowercase(Locale.ROOT)

    private fun swapLetters(token: String): String {
        val core = token.trim('!')
        if (core.none(Char::isLetter) && core.none { it == '@' || it == '$' }) return core
        return buildString(core.length) { core.forEach { append(LETTER_SWAPS[it] ?: it) } }
    }

    private fun withCollapsedRepeats(token: String): Sequence<String> = sequence {
        yield(token)
        if (STRETCHED.containsMatchIn(token)) {
            yield(token.replace(STRETCHED, "$1"))
            yield(token.replace(STRETCHED, "$1$1"))
        }
    }

    private fun spelledOutWords(tokens: List<String>): Sequence<String> = sequence {
        var run = StringBuilder()
        for (token in tokens) {
            if (token.length == 1) {
                run.append(token)
            } else {
                if (run.length >= MIN_SPELLED_OUT) yield(run.toString())
                run = StringBuilder()
            }
        }
        if (run.length >= MIN_SPELLED_OUT) yield(run.toString())
    }

    companion object {
        private val RAW_TOKEN = Regex("[\\p{L}\\p{N}@$!]+")
        private val IGNORED_CHARACTERS = Regex("[\\p{M}\\p{Cf}]")
        private val STRETCHED = Regex("(.)\\1{2,}")
        private const val MIN_SPELLED_OUT = 3
        private val LETTER_SWAPS = mapOf(
            '0' to 'o', '1' to 'i', '3' to 'e', '4' to 'a', '5' to 's', '7' to 't',
            '@' to 'a', '$' to 's', '!' to 'i'
        )
        private const val WORD_LIST_RESOURCE = "/content-filter/en.txt"

        fun fromResource(): ContentFilter {
            val stream = ContentFilter::class.java.getResourceAsStream(WORD_LIST_RESOURCE)
                ?: error("Missing word list $WORD_LIST_RESOURCE")
            val terms = stream.bufferedReader().useLines { lines ->
                lines.map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.toList()
            }
            return ContentFilter(terms)
        }
    }
}
