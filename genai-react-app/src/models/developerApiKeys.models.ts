export interface CreateDeveloperApiKeyRequest {
    name: string
}

/**
 * Returned once at creation time — the only moment `apiKey` is ever exposed.
 */
export interface DeveloperApiKeyCreatedResponse {
    keyId: string
    name: string
    apiKey: string
    prefix: string
    createdAt: string
}

/** Requests and cost for the last 30 UTC days and all time; null when usage couldn't be read. */
export interface DeveloperApiKeyUsage {
    requests30d?: number | null
    costUsd30d?: number | null
    requestsAllTime?: number | null
    costUsdAllTime?: number | null
}

export interface DeveloperApiKeySummary extends DeveloperApiKeyUsage {
    keyId: string
    name: string
    prefix: string
    createdAt?: string
    lastUsedAt?: string
}

export interface ListDeveloperApiKeysResponse {
    keys: DeveloperApiKeySummary[]
    /** Sums over every key; absent from servers older than per-key usage. */
    totals?: DeveloperApiKeyUsage
}
