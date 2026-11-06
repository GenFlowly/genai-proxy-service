import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { fetchWithRetry } from "../utils/apiUtils";
import { LearnedFact } from "../models/conversation.models";
import { deleteAllMemories, deleteMemory } from "./memoriesService";

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
 * Delete one learned fact from the user's memory. A memory already deleted
 * (from the Memory page or another tab) counts as success — the end state
 * the user asked for is reached either way.
 */
export async function deleteMemoryFact(token: string, memoryId: string): Promise<void> {
    await deleteMemory(token, memoryId)
}

/** Delete every fact learned about the user. Resolves to how many were deleted. */
export async function deleteAllMemoryFacts(token: string): Promise<number> {
    return deleteAllMemories(token)
}
