package com.genflowly.utils

/**
 * Minimal {{variable}} substitution for prompt templates stored in DynamoDB
 * instructions or the bundled defaults. Unresolved placeholders fail loudly —
 * a prompt silently containing a literal "{{categoryJson}}" would produce
 * garbage generations that are much harder to trace than an exception.
 * Variables not referenced by the template are ignored, so callers may pass
 * a superset.
 */
object PromptTemplateRenderer {

    private val PLACEHOLDER = Regex("""\{\{\s*([A-Za-z0-9_]+)\s*}}""")

    fun render(template: String, variables: Map<String, String>): String =
        PLACEHOLDER.replace(template) { match ->
            val name = match.groupValues[1]
            variables[name]
                ?: throw IllegalArgumentException(
                    "Unresolved placeholder '{{$name}}' in prompt template; " +
                            "provided variables: ${variables.keys.sorted()}"
                )
        }
}
