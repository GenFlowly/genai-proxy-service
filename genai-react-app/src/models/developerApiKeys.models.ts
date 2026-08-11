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

export interface DeveloperApiKeySummary {
    keyId: string
    name: string
    prefix: string
    createdAt?: string
    lastUsedAt?: string
}

export interface ListDeveloperApiKeysResponse {
    keys: DeveloperApiKeySummary[]
}
