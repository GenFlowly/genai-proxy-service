export enum AIVendor {
    OPENAI = 'OPENAI',
    CLAUDE = 'CLAUDE',
    GEMINI = 'GEMINI',
}

// The legacy three vendors are stored/addressed by their uppercase enum
// names; every other provider uses its lowercase catalog id (the backend
// normalizes the same way — see AIVendor.kt).
export const LEGACY_BY_CATALOG_ID: Record<string, string> = {
    openai: AIVendor.OPENAI,
    anthropic: AIVendor.CLAUDE,
    gemini: AIVendor.GEMINI,
}

export const catalogIdFor = (storedId: string): string =>
    Object.entries(LEGACY_BY_CATALOG_ID).find(([, legacy]) => legacy === storedId)?.[0] ?? storedId

/**
 * Display-name placeholder until the provider catalog has loaded; mirrors
 * the catalog's own fallback rule (title-cased catalog id). Real names come
 * from the catalog via useVendorDisplayNames — never hardcode them here.
 */
export const fallbackVendorDisplayName = (vendorId: string): string =>
    catalogIdFor(vendorId)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
