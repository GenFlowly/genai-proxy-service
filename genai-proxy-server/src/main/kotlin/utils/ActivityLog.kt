package com.genflowly.utils

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray

/**
 * Persistence of a turn's activity log: the retrieval server's `activity`
 * events (contract v2, see retrieval-server/activity/schema.py), in stream
 * order, stored as `Message.activityJson`.
 *
 * The log shares a 400 KB DynamoDB item with the message, so an oversized log
 * is shrunk in a fixed order, stopping at the first step that fits: developer
 * excerpts, then each call's result excerpt, then each call's sources beyond
 * the first [MAX_SOURCES_PER_CALL], then long argument strings, then memory
 * texts (their counts stay). The story and the evidence stay readable at
 * every step.
 */
object ActivityLog {

    const val MAX_PERSISTED_CHARS = 250_000
    const val MAX_SOURCES_PER_CALL = 10
    const val MAX_ARG_CHARS = 500

    private val json = Json { ignoreUnknownKeys = true }

    private val shrinkSteps: List<(JsonObject) -> JsonObject> = listOf(
        { e -> JsonObject(e - "developer") },
        { e -> mapCalls(e) { c -> JsonObject(c - "result_excerpt") } },
        { e -> mapCalls(e) { c -> capSources(c) } },
        { e -> mapCalls(e) { c -> truncateArgs(c) } },
        { e -> if (isMemoryEnd(e)) JsonObject(e - "memories") else e },
    )

    /** JSON array text to persist, or null when the turn produced no activity. */
    fun toPersistedJson(events: List<String>, maxChars: Int = MAX_PERSISTED_CHARS): String? {
        if (events.isEmpty()) return null
        val full = events.joinToString(",", "[", "]")
        if (full.length <= maxChars) return full
        var parsed = runCatching { json.parseToJsonElement(full).jsonArray.toList() }.getOrNull() ?: return null
        var out = full
        for (step in shrinkSteps) {
            parsed = parsed.map { if (it is JsonObject) step(it) else it }
            out = JsonArray(parsed).toString()
            if (out.length <= maxChars) return out
        }
        return out
    }

    internal fun isMemoryEnd(event: JsonObject): Boolean =
        event.string("type") == "step.end" && event.string("kind") == "memory"

    internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    private fun mapCalls(event: JsonObject, transform: (JsonObject) -> JsonObject): JsonObject {
        val calls = event["calls"] as? JsonArray ?: return event
        return JsonObject(event + ("calls" to JsonArray(calls.map { if (it is JsonObject) transform(it) else it })))
    }

    private fun capSources(call: JsonObject): JsonObject {
        val sources = call["sources"] as? JsonArray ?: return call
        if (sources.size <= MAX_SOURCES_PER_CALL) return call
        return JsonObject(call + ("sources" to JsonArray(sources.take(MAX_SOURCES_PER_CALL))))
    }

    private fun truncateArgs(call: JsonObject): JsonObject {
        val args = call["args"] as? JsonObject ?: return call
        val shortened = args.mapValues { (_, v) -> truncate(v) }
        return JsonObject(call + ("args" to JsonObject(shortened)))
    }

    private fun truncate(value: JsonElement): JsonElement {
        val primitive = value as? JsonPrimitive ?: return value
        val text = primitive.contentOrNull
        return if (primitive.isString && text != null && text.length > MAX_ARG_CHARS) {
            JsonPrimitive(text.take(MAX_ARG_CHARS) + "…")
        } else value
    }
}
