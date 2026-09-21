import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { fetchWithRetry } from "../utils/apiUtils";
import { readNdjsonStream, StreamCallbacks } from "./generateTextStreamService";

/**
 * Reattach to an in-flight durable run's event stream (reload recovery). Relays
 * the same NDJSON frames as generate-text-stream into [callbacks], replaying
 * after [fromSeq], and resolves when the run's stream ends. A 404 means the run
 * is no longer this conversation's active run (already finished) — treated as a
 * no-op so a stale pendingRunId doesn't surface an error.
 */
export async function reattachRun(
    token: string,
    runId: string,
    conversationId: string,
    callbacks: StreamCallbacks,
    fromSeq = 0,
    signal?: AbortSignal,
): Promise<void> {
    const response = await fetchWithRetry(endpoints.reattachRun(runId, conversationId, fromSeq), {
        method: HttpMethod.GET,
        headers: { Authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) {
        if (response.status === 404) return; // run already finished — nothing to reattach
        throw new Error(`Reattach failed: ${response.status} ${response.statusText}`);
    }
    await readNdjsonStream(response, callbacks);
}
