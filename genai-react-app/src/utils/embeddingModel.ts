import type { AIConfigPreferences } from '../stores/aiPreferencesStore'
import { EmbeddingVendor, EmbeddingVendorModels } from '../services/embeddingKeysService'

/** In use until the customer chooses one. Must match EmbeddingConstants.MODEL_NAME in the proxy server. */
export const PLATFORM_EMBEDDING_MODEL = 'voyage-4-large'

/**
 * The customer's one embedding model, read the way the server locks it: the
 * conversations field, else the single field, else the notes field. Null
 * when none is chosen yet.
 */
export function chosenEmbeddingModel(preferences: Partial<AIConfigPreferences> | null | undefined): string | null {
    const candidates = [preferences?.embeddingModelConversations, preferences?.embeddingModel, preferences?.embeddingModelNotes]
    return candidates.find(model => !!model?.trim())?.trim() ?? null
}

/** voyage-* → Voyage, text-embedding-* → OpenAI, else null. */
export function embeddingVendorFor(model: string | null | undefined): EmbeddingVendor | null {
    if (!model) return null
    if (model.startsWith('voyage')) return EmbeddingVendor.VOYAGE
    if (model.startsWith('text-embedding')) return EmbeddingVendor.OPENAI
    return null
}

/**
 * Whether a locked model can no longer be used, by the same rules the server
 * uses to allow a fresh choice: its name belongs to no known vendor, or its
 * vendor's key works but no longer lists it. A vendor missing from the list
 * (no key, or a key that can't embed) keeps the lock.
 */
export function isEmbeddingModelUnusable(model: string, vendorModels: EmbeddingVendorModels[]): boolean {
    const vendor = embeddingVendorFor(model)
    if (!vendor) return true
    const listed = vendorModels.find(entry => entry.vendor === vendor)
    return !!listed && !listed.models.includes(model)
}
