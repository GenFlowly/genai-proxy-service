import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { AIConfig } from '../context/AIContext'
import { fetchWithRetry } from "../utils/apiUtils";

export interface SaveAIConfigPreferencesRequest {
    aiConfigPreferences: {
        preferredModels?: AIConfig[]
        /** Preferred conversation agent (graphId). Empty string clears it. */
        preferredAgentId?: string
        /** Legacy single default embedding model name (e.g. voyage-4-large). */
        embeddingModel?: string
        /** Default embedding model for conversation indexing. */
        embeddingModelConversations?: string
        /** Default embedding model for notes. */
        embeddingModelNotes?: string
    }
    otherPreferences?: Record<string, string>
}

export async function saveAIConfigPreferences(
    token: string,
    payload: SaveAIConfigPreferencesRequest
): Promise<void> {
    const response = await fetchWithRetry(endpoints.saveAIConfig, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        // Surface the server's validation message (e.g. an unsupported embedding
        // model) so the caller's toast explains what to fix, not just the status.
        let serverError: string | undefined
        try {
            const body = await response.json()
            serverError = body?.error
        } catch {
            // No / invalid JSON body — fall back to the status line below.
        }
        throw new Error(
            serverError || `Failed to save AI config preferences: ${response.statusText}`
        )
    }
}
