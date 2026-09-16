export enum AIVendor {
    OPENAI = 'OPENAI',
    CLAUDE = 'CLAUDE',
    GEMINI = 'GEMINI',
}

/** Plain-text vendor names for dropdowns (brand components stay in BrandName). */
export const VENDOR_LABELS: Record<AIVendor, string> = {
    [AIVendor.OPENAI]: 'OpenAI',
    [AIVendor.CLAUDE]: 'Claude',
    [AIVendor.GEMINI]: 'Gemini',
}
