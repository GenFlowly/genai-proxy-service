import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { fetchWithRetry } from "../utils/apiUtils";

export interface AIUsageMetrics {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    tokensReadFromCache?: number;
}

export async function getAIUsageActivity(
    token: string,
    conversationId: string,
    messageId: string
): Promise<AIUsageMetrics | null> {
    try {
        const urlObj = new URL(endpoints.getAIUsage);
        urlObj.searchParams.append("conversationId", conversationId);
        urlObj.searchParams.append("messageId", messageId);

        const response = await fetchWithRetry(urlObj.toString(), {
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
