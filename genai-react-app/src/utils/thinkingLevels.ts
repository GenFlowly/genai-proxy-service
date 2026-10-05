/**
 * Valid values for an LLM node's `thinking_level` config key, derived from
 * the model the node will run on. Mirrors the vendor mapping applied by the
 * retrieval-server (graph/llm_factory.py):
 *   - OpenAI gpt-5 family → reasoning_effort (minimal/low/medium/high);
 *     o-series → reasoning_effort (low/medium/high, no off switch)
 *   - Anthropic Claude 4.6+/5 families → adaptive thinking + effort
 *   - Gemini 2.5 → thinking_budget (0/1024/8192/24576; 2.5 Pro can't disable)
 *   - Gemini 3 → thinking_level (minimal/low/medium/high)
 * Unset ("Default") always means: keep the vendor's default behavior.
 */

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high'

export interface ThinkingLevelOption {
    value: ThinkingLevel
    /** The native vendor setting this level maps to, shown next to the label. */
    native: string
}

export type ThinkingVendor = 'openai' | 'anthropic' | 'gemini' | 'generic' | 'unsupported'

export interface ThinkingLevelInfo {
    vendor: ThinkingVendor
    /** Empty when the model has no thinking controls at all. */
    options: ThinkingLevelOption[]
}

// Claude families that accept adaptive thinking — keep in sync with
// _ADAPTIVE_THINKING_MODELS in retrieval-server/graph/llm_factory.py
const ADAPTIVE_CLAUDE_PREFIXES = [
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-fable-5',
    'claude-mythos-5',
]

const GENERIC_OPTIONS: ThinkingLevelOption[] = [
    { value: 'none', native: '' },
    { value: 'low', native: '' },
    { value: 'medium', native: '' },
    { value: 'high', native: '' },
]

/**
 * Options for the given model id. An empty/unknown model (e.g. response
 * generator nodes, whose model is picked per chat request) gets the full
 * generic list — the server applies it per vendor at request time and
 * ignores it where unsupported.
 */
export function getThinkingLevelInfo(model?: string): ThinkingLevelInfo {
    const m = (model ?? '').trim().toLowerCase()

    if (!m) return { vendor: 'generic', options: GENERIC_OPTIONS }

    if (m.startsWith('gpt-5')) {
        return {
            vendor: 'openai',
            options: [
                { value: 'none', native: 'reasoning_effort: minimal' },
                { value: 'low', native: 'reasoning_effort: low' },
                { value: 'medium', native: 'reasoning_effort: medium' },
                { value: 'high', native: 'reasoning_effort: high' },
            ],
        }
    }
    if (/^o[134]/.test(m)) {
        // o-series reasoning models have no off/minimal setting
        return {
            vendor: 'openai',
            options: [
                { value: 'low', native: 'reasoning_effort: low' },
                { value: 'medium', native: 'reasoning_effort: medium' },
                { value: 'high', native: 'reasoning_effort: high' },
            ],
        }
    }
    if (m.startsWith('gpt-') || m.startsWith('chatgpt')) {
        return { vendor: 'unsupported', options: [] }
    }

    if (m.startsWith('claude')) {
        if (ADAPTIVE_CLAUDE_PREFIXES.some(p => m.startsWith(p))) {
            return {
                vendor: 'anthropic',
                options: [
                    { value: 'none', native: 'thinking off' },
                    { value: 'low', native: 'adaptive thinking, effort: low' },
                    { value: 'medium', native: 'adaptive thinking, effort: medium' },
                    { value: 'high', native: 'adaptive thinking, effort: high' },
                ],
            }
        }
        // Older Claude models (haiku-4-5, sonnet-4-5, …): thinking is already
        // off by default and the adaptive form is unsupported
        return { vendor: 'unsupported', options: [] }
    }

    if (m.startsWith('gemini-3')) {
        return {
            vendor: 'gemini',
            options: [
                { value: 'none', native: 'thinking_level: minimal' },
                { value: 'low', native: 'thinking_level: low' },
                { value: 'medium', native: 'thinking_level: medium' },
                { value: 'high', native: 'thinking_level: high' },
            ],
        }
    }
    if (m.startsWith('gemini-2.5')) {
        const isPro = m.includes('pro')
        return {
            vendor: 'gemini',
            options: [
                { value: 'none', native: isPro ? 'thinking budget: 128 (minimum)' : 'thinking budget: 0' },
                { value: 'low', native: 'thinking budget: 1024' },
                { value: 'medium', native: 'thinking budget: 8192' },
                { value: 'high', native: 'thinking budget: 24576' },
            ],
        }
    }
    if (m.startsWith('gemini')) {
        return { vendor: 'unsupported', options: [] }
    }

    // Unknown vendor (long-tail BYOK models) — the server ignores the value
    // for providers without a thinking control, so offer the generic list.
    return { vendor: 'generic', options: GENERIC_OPTIONS }
}
