import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";

/**
 * Deliver a human/client reply to a durable run paused on an in-graph
 * interrupt(); the run resumes from its checkpoint. Returns true when the proxy
 * accepted the delivery. Plain fetch (no retry) — resume is not idempotent.
 */
export async function resumeRun(
    token: string,
    runId: string,
    conversationId: string,
    payload: unknown,
): Promise<boolean> {
    const response = await fetch(endpoints.resumeRun(runId, conversationId), {
        method: HttpMethod.POST,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok) return false;
    try {
        const body = await response.json();
        return body?.resumed === true;
    } catch {
        return true;
    }
}
