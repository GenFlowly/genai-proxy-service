package com.genflowly.service

import com.genflowly.config.AppConfig

/**
 * Math-delimiter contract between generations and the component-library
 * markdown renderer (TextContainer) used by our UIs.
 *
 * The renderer accepts TeX-style \( ... \) / \[ ... \] delimiters (it
 * normalizes them to the double-dollar forms remark-math parses) but
 * deliberately does NOT parse single-dollar $...$ inline math — currency
 * amounts in prose would false-match and get typeset as math
 * (component-library commit 91271c0). Vendors default to the dollar
 * convention unless told otherwise, so every turn rendered by our UIs
 * carries this guidance.
 *
 * Scope: appended only for our own markdown-rendering UI clients.
 * Developer API-key traffic and internal utility generations (titles,
 * personas, memory extraction) are never altered.
 */
object ResponseFormatting {

    private val MARKDOWN_UI_CLIENTS = setOf(
        AppConfig.CLIENT_REACT_APP,
        AppConfig.CLIENT_ADMIN_PANEL,
    )

    const val MATH_FORMATTING_GUIDANCE =
        "When writing mathematical notation, use LaTeX delimited with \\( ... \\) " +
            "for inline math and \\[ ... \\] for display equations. Never use " +
            "\$ ... \$ or \$\$ ... \$\$ as math delimiters — dollar signs are " +
            "reserved for currency and render as plain text. Inside Markdown " +
            "table cells, write \\mid instead of the | character in math " +
            "expressions."

    /**
     * The system prompt actually sent to the vendor for a turn: the resolved
     * instruction plus [MATH_FORMATTING_GUIDANCE] for markdown-rendering UI
     * clients. Callers persist the undecorated instruction — the guidance is
     * transport-level, not part of the applied instruction record.
     *
     * Structured-output turns are returned unchanged: their response is
     * machine-parsed JSON, not rendered markdown, and the extra instruction
     * could only distort the schema-constrained output.
     */
    fun decorateSystemPrompt(
        systemPrompt: String,
        client: String,
        structuredOutput: Boolean,
    ): String {
        if (structuredOutput || client !in MARKDOWN_UI_CLIENTS) return systemPrompt
        if (systemPrompt.isBlank()) return MATH_FORMATTING_GUIDANCE
        return "$systemPrompt\n\n$MATH_FORMATTING_GUIDANCE"
    }
}
