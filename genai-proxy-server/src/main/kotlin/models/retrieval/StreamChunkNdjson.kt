package com.genflowly.models.retrieval

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray

/**
 * Maps a [StreamChunk] to the newline-delimited JSON frame the web app consumes,
 * or null for chunks that carry no client frame (Usage — captured for
 * persistence, never relayed). Shared by the live generate-text-stream path and
 * the durable-run reattach stream so both emit the identical wire protocol:
 *
 *   c  = content token      k  = thinking            ks = thinking step
 *   kd = thinking duration  tc = tool calls          ws = web sources
 *   ga = generated files    ai = awaiting input       err = error
 *   cr = content reset (discard accumulated content — a new round follows)
 *   sr = stop reason (vendor's raw finish reason for the terminated turn)
 *   pg = progress while a tool's arguments are written, e.g.
 *        {"tool":"generate_pdf","chars":1234} (transient: shown until the
 *        next content/ga/err frame or the stream end, never persisted)
 *
 * A `ga` frame carries each artifact's [BROWSER_ARTIFACT_FIELDS] only: the S3
 * keys (`key`, `source_key`) stay server-side, and downloads go through the
 * attachment id.
 *
 * `json`-backed chunks are already valid JSON (object/array) and are embedded
 * as-is; text values are JSON-escaped via JsonPrimitive.
 */
fun StreamChunk.toNdjsonFrame(): String? = when (this) {
    is StreamChunk.Content -> "{\"t\":\"c\",\"v\":${JsonPrimitive(text)}}\n"
    is StreamChunk.ContentReset -> "{\"t\":\"cr\"}\n"
    is StreamChunk.StopReason -> "{\"t\":\"sr\",\"v\":${JsonPrimitive(reason)}}\n"
    is StreamChunk.Thinking -> "{\"t\":\"k\",\"v\":${JsonPrimitive(text)}}\n"
    is StreamChunk.ThinkingStep -> "{\"t\":\"ks\",\"v\":$json}\n"
    is StreamChunk.ThinkingDuration -> "{\"t\":\"kd\",\"v\":$millis}\n"
    is StreamChunk.ToolCalls -> "{\"t\":\"tc\",\"v\":$json}\n"
    is StreamChunk.WebSources -> "{\"t\":\"ws\",\"v\":$json}\n"
    is StreamChunk.GeneratedArtifacts -> "{\"t\":\"ga\",\"v\":${browserArtifactsJson(json)}}\n"
    is StreamChunk.AwaitingInput -> "{\"t\":\"ai\",\"v\":$json}\n"
    is StreamChunk.Progress -> "{\"t\":\"pg\",\"v\":$json}\n"
    is StreamChunk.Error -> "{\"t\":\"err\",\"v\":${JsonPrimitive(message)}}\n"
    is StreamChunk.Usage -> null
}

/**
 * The generated-artifact fields a browser receives (contract C1, plans 1.15 and
 * 6.4). Everything else, in particular the S3 `key` and `source_key`, stays
 * server-side; persistence reads the full artifact from the chunk itself.
 */
internal val BROWSER_ARTIFACT_FIELDS = setOf("artifact_id", "media_type", "filename", "size_bytes", "page_count")

/**
 * A generated_artifacts array with each artifact cut down to
 * [BROWSER_ARTIFACT_FIELDS]. Elements that are not objects are dropped, and
 * input that is not a JSON array yields "[]", so nothing unvetted reaches the
 * browser.
 */
internal fun browserArtifactsJson(json: String): String = runCatching {
    JsonArray(
        Json.parseToJsonElement(json).jsonArray.mapNotNull { element ->
            (element as? JsonObject)?.let { artifact ->
                JsonObject(artifact.filterKeys { it in BROWSER_ARTIFACT_FIELDS })
            }
        }
    ).toString()
}.getOrDefault("[]")
