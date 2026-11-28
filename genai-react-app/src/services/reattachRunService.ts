import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { fetchWithRetry } from "../utils/apiUtils";
import { readNdjsonStream, StreamCallbacks } from "./generateTextStreamService";

/**
 * Reattach to an in-flight durable run's event stream (reload recovery). Relays
 * the same NDJSON frames as generate-text-stream into [callbacks], replaying
 * after [fromSeq], and resolves when the run's stream ends. Resolves false on a
 * 404: the run is no longer this conversation's active run, so its reply is
 * saved and the stream has nothing to add.
 */
export async function reattachRun(
    token: string,
    runId: string,
    conversationId: string,
    callbacks: StreamCallbacks,
    fromSeq = 0,
    signal?: AbortSignal,
): Promise<boolean> {
    const response = await fetchWithRetry(endpoints.reattachRun(runId, conversationId, fromSeq), {
        method: HttpMethod.GET,
        headers: { Authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) {
        if (response.status === 404) return false;
        const err: any = new Error(`Reattach failed: ${response.status} ${response.statusText}`);
        err.status = response.status;
        throw err;
    }
    await readNdjsonStream(response, callbacks);
    return true;
}
