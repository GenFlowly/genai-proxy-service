package com.genflowly.utils

import com.genflowly.utils.ActivityLog.isMemoryEnd
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Memory privacy for shared conversations.
 *
 * A turn's activity log carries the turn author's long-term memory texts (the
 * memory step's `memories`) and developer data that can echo them (each llm
 * step's prompt and response excerpts, a subagent call's own trace in
 * `details`). Those belong to the user they were loaded for. Any OTHER viewer
 * of the conversation (the owner reading a share recipient's turn, a share
 * recipient, a PUBLIC-link visitor, a logged-out reader) learns how many
 * memories were applied, from the memory step's `counts`, and nothing else.
 */
object MemoryRedaction {

    private val json = Json { ignoreUnknownKeys = true }

    /** Redacts a persisted activity log (the parsed Message.activityJson) for a non-author viewer. */
    fun redactActivity(events: JsonElement): JsonElement =
        if (events is JsonArray) JsonArray(events.map(::redactEvent)) else events

    /**
     * Redacts one live `ac` frame payload for a non-author viewer. Returns null
     * when the payload doesn't parse: the caller drops the frame rather than
     * relay content it couldn't inspect.
     */
    fun redactActivityEventJson(eventJson: String): String? {
        val event = runCatching { json.parseToJsonElement(eventJson) }.getOrNull() ?: return null
        return redactEvent(event).toString()
    }

    private fun redactEvent(event: JsonElement): JsonElement {
        if (event !is JsonObject) return event
        var out = JsonObject(event - "developer")
        if (isMemoryEnd(out)) out = JsonObject(out - "memories")
        val calls = out["calls"] as? JsonArray
        if (calls != null) {
            out = JsonObject(out + ("calls" to JsonArray(calls.map { c ->
                if (c is JsonObject) JsonObject(c - "details") else c
            })))
        }
        return out
    }
}
