import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { fetchWithRetry } from "../utils/apiUtils";

export interface AIUsageMetrics {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    tokensReadFromCache?: number;
    /** Exact USD cost of the message, computed and persisted server-side. */
    costUsd?: number | null;
}

export async function getAIUsageActivity(
    token: string,
    conversationId: string,
    messageId: string
): Promise<AIUsageMetrics | null> {
    try {
        // endpoints.* can be relative when the backend base URL is empty
        // (same-origin / dev proxy setups); new URL() rejects relative URLs,
        // so build the query string directly like the other services do.
        const params = new URLSearchParams({ conversationId, messageId });
        const url = `${endpoints.getAIUsage}?${params.toString()}`;

        const response = await fetchWithRetry(url, {
            method: HttpMethod.GET,
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            console.warn(`Failed to fetch AI usage: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        return data as AIUsageMetrics;
    } catch (e) {
        console.error("Error fetching AI Usage:", e);
        return null;
    }
}
