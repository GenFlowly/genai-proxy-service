export enum AIVendor {
    OPENAI = 'OPENAI',
    CLAUDE = 'CLAUDE',
    GEMINI = 'GEMINI',
}

export const VENDOR_LABELS: Record<AIVendor, string> = {
    [AIVendor.OPENAI]: 'OpenAI',
    [AIVendor.CLAUDE]: 'Claude (Anthropic)',
    [AIVendor.GEMINI]: 'Gemini (Google)',
}
