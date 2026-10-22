package com.genflowly.utils

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Memory privacy for shared conversations.
 *
 * A MEMORY thinking step carries the turn author's actual long-term memory
 * texts (`memories` {core, recalled} and the flat `items` fallback). Those are
 * private to the user they were loaded for: any OTHER viewer of the
 * conversation — the owner reading a share recipient's turn, a share
 * recipient, a PUBLIC-link visitor, a logged-out reader — may only learn how
 * many memories were applied. The step's `detail` line already says exactly
 * that ("Applied N core memori(es); recalled M related to this message"), so
 * redaction removes the content-bearing keys and keeps the counts.
 */
object MemoryRedaction {

    /** MEMORY-step keys that carry memory texts rather than counts. */
    private val CONTENT_KEYS = setOf("memories", "items")

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Redacts every MEMORY step in a persisted thinking-steps array (the
     * element parsed from Message.thinkingStepsJson). Non-MEMORY steps and
     * unexpected shapes pass through unchanged.
     */
    fun redactThinkingSteps(steps: JsonElement): JsonElement =
        if (steps is JsonArray) JsonArray(steps.map(::redactStep)) else steps

    /**
     * Redacts one live "ks" frame payload (StreamChunk.ThinkingStep.json) for
     * relaying to a viewer who isn't the turn's author. Returns null when the
     * payload doesn't parse — the caller must drop the frame rather than relay
     * content it couldn't inspect.
     */
    fun redactThinkingStepJson(stepJson: String): String? {
        val step = runCatching { json.parseToJsonElement(stepJson) }.getOrNull() ?: return null
        return redactStep(step).toString()
    }

    private fun redactStep(step: JsonElement): JsonElement {
        if (step !is JsonObject) return step
        val kind = (step["kind"] as? JsonPrimitive)?.contentOrNull
        if (kind != "MEMORY") return step
        return JsonObject(step.filterKeys { it !in CONTENT_KEYS })
    }
}
