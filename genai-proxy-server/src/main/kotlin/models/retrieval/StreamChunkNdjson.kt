package com.genflowly.models.retrieval

import kotlinx.serialization.json.JsonPrimitive

/**
 * Maps a [StreamChunk] to the newline-delimited JSON frame the web app consumes,
 * or null for chunks that carry no client frame (Usage — captured for
 * persistence, never relayed; Position — stamped on later frames instead).
 * Shared by the live generate-text-stream path and the durable-run reattach
 * stream so both emit the identical wire protocol:
 *
 *   c  = content token      ac = activity event      tc = tool calls
 *   ws = web sources        ga = generated files     ai = awaiting input
 *   err = error
 *   cr = content reset (discard accumulated content — a new round follows)
 *   sr = stop reason (vendor's raw finish reason for the terminated turn)
 *   run = durable run opened: v = run id, ms = turn elapsed (may be absent)
 *   done = terminal frame, see [doneNdjsonFrame]
 *
 * [seq] adds `"s":<seq>`, the run_events seq of the event the frame came from,
 * so a client can reattach with `fromSeq=<s>` after a dropped connection.
 * Frames of the stateless fallback stream carry none.
 *
 * `json`-backed chunks are already valid JSON (object/array) and are embedded
 * as-is; text values are JSON-escaped via JsonPrimitive.
 */
fun StreamChunk.toNdjsonFrame(seq: Long? = null): String? {
    val s = seq?.let { ",\"s\":$it" } ?: ""
    return when (this) {
        is StreamChunk.Content -> "{\"t\":\"c\",\"v\":${JsonPrimitive(text)}$s}\n"
        is StreamChunk.ContentReset, is StreamChunk.RunRestarted -> "{\"t\":\"cr\"$s}\n"
        is StreamChunk.StopReason -> "{\"t\":\"sr\",\"v\":${JsonPrimitive(reason)}$s}\n"
        is StreamChunk.Activity -> "{\"t\":\"ac\",\"v\":$json$s}\n"
        is StreamChunk.ToolCalls -> "{\"t\":\"tc\",\"v\":$json$s}\n"
        is StreamChunk.WebSources -> "{\"t\":\"ws\",\"v\":$json$s}\n"
        is StreamChunk.GeneratedArtifacts -> "{\"t\":\"ga\",\"v\":$json$s}\n"
        is StreamChunk.AwaitingInput -> "{\"t\":\"ai\",\"v\":$json$s}\n"
        is StreamChunk.Error -> "{\"t\":\"err\",\"v\":${JsonPrimitive(message)}$s}\n"
        is StreamChunk.RunStarted -> {
            val ms = elapsedMs?.let { ",\"ms\":$it" } ?: ""
            "{\"t\":\"run\",\"v\":${JsonPrimitive(runId)},\"s\":$fromSeq$ms}\n"
        }
        is StreamChunk.Usage, is StreamChunk.Position -> null
    }
}

/**
 * Terminal frame marking the definitive end of a generation stream, emitted by
 * the generation orchestrator (after the response is persisted or confirmed
 * unpersisted) and by the durable-run reattach route (after its relay loop
 * ends). Without this, the client cannot tell "the server finished" from "the
 * connection died mid-response" — both look identical as a closed stream —
 * so it would silently treat a truncated response as complete. [status] is
 * "ok" | "error" | "cancelled"; [message] carries the error reason when
 * [status] is "error"; [seq] is the last seq relayed, as on every frame.
 */
fun doneNdjsonFrame(status: String, message: String? = null, seq: Long? = null): String {
    val messageField = message?.let { ",\"m\":${JsonPrimitive(it)}" } ?: ""
    val s = seq?.let { ",\"s\":$it" } ?: ""
    return "{\"t\":\"done\",\"status\":${JsonPrimitive(status)}$messageField$s}\n"
}

/**
 * Frames one client stream, stamping each frame with the seq of the run event
 * it came from ([StreamChunk.Position]). Frames the proxy adds itself (the
 * synthesized answer after a restart, `sr interrupted`, `done`) carry the last
 * seq relayed. Until a durable run's first position, frames carry no seq.
 */
class NdjsonFramer {
    var seq: Long? = null
        private set

    fun frame(chunk: StreamChunk): String? {
        when (chunk) {
            is StreamChunk.Position -> seq = chunk.seq
            is StreamChunk.RunStarted -> seq = chunk.fromSeq
            else -> {}
        }
        return chunk.toNdjsonFrame(seq)
    }

    fun done(status: String, message: String? = null): String = doneNdjsonFrame(status, message, seq)
}
