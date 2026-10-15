import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { fetchWithRetry } from "../utils/apiUtils";
import { readNdjsonStream, StreamCallbacks } from "./generateTextStreamService";

/**
 * How a reattach ended: "streamed" — the run's stream was relayed until it
 * ended; "gone" — 404, the run is no longer this conversation's active run
 * (it already finished, successfully or not).
 */
export type ReattachOutcome = "streamed" | "gone";

/**
 * Reattach to an in-flight durable run's event stream (reload recovery). Relays
 * the same NDJSON frames as generate-text-stream into [callbacks], replaying
 * after [fromSeq], and resolves when the run's stream ends. A 404 resolves to
 * "gone" rather than an error, so a stale pendingRunId doesn't surface one; the
 * caller then reads the stored message, which carries the turn's error when
 * the run failed. A failed run's "err" frame rejects with StreamGenerationError.
 */
export async function reattachRun(
    token: string,
    runId: string,
    conversationId: string,
    callbacks: StreamCallbacks,
    fromSeq = 0,
    signal?: AbortSignal,
): Promise<ReattachOutcome> {
    const response = await fetchWithRetry(endpoints.reattachRun(runId, conversationId, fromSeq), {
        method: HttpMethod.GET,
        headers: { Authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) {
        if (response.status === 404) return "gone";
        throw new Error(`Reattach failed: ${response.status} ${response.statusText}`);
    }
    await readNdjsonStream(response, callbacks);
    return "streamed";
}
