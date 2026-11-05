import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { fetchWithRetry } from "../utils/apiUtils";
import { LearnedFact } from "../models/conversation.models";

/**
 * Result of the async memory-extraction pipeline for one assistant message.
 * `pending` means extraction hasn't finished yet — poll again later.
 */
export interface LearnedFactsResult {
    status: 'pending' | 'done';
    facts: LearnedFact[];
}

/**
 * Fetch the facts learned about the user from the exchange that produced
 * `messageId`. Throws on HTTP errors so pollers can decide to retry.
 */
export async function getLearnedFacts(
    token: string,
    conversationId: string,
    messageId: string
): Promise<LearnedFactsResult> {
    const response = await fetchWithRetry(endpoints.getLearnedFacts(conversationId, messageId), {
        method: HttpMethod.GET,
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch learned facts: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return {
        status: data.status === 'pending' ? 'pending' : 'done',
        facts: Array.isArray(data.facts) ? data.facts : [],
    };
}

/**
 * Delete one learned fact from the user's memory. A 404 (already deleted, e.g.
 * from the Memory page or another tab) counts as success — the end state the
 * user asked for is reached either way.
 */
export async function deleteMemoryFact(
    token: string,
    memoryId: string
): Promise<void> {
    const response = await fetchWithRetry(endpoints.deleteMemoryFact(memoryId), {
        method: HttpMethod.DELETE,
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });

    if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete memory fact: ${response.status} ${response.statusText}`);
    }
}

/**
 * Delete every fact learned about the user. Resolves to how many were
 * deleted.
 */
export async function deleteAllMemoryFacts(token: string): Promise<number> {
    const response = await fetchWithRetry(endpoints.deleteAllMemoryFacts, {
        method: HttpMethod.DELETE,
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to delete learned facts: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return typeof data.deleted === 'number' ? data.deleted : 0;
}
