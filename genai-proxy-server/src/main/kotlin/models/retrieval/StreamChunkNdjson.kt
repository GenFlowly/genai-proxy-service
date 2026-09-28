package com.genflowly.models.retrieval

import kotlinx.serialization.json.JsonPrimitive

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
    is StreamChunk.GeneratedArtifacts -> "{\"t\":\"ga\",\"v\":$json}\n"
    is StreamChunk.AwaitingInput -> "{\"t\":\"ai\",\"v\":$json}\n"
    is StreamChunk.Error -> "{\"t\":\"err\",\"v\":${JsonPrimitive(message)}}\n"
    is StreamChunk.Usage -> null
}
