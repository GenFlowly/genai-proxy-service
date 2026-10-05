import { getThinkingLevelInfo } from '../../utils/thinkingLevels'

describe('getThinkingLevelInfo', () => {
    it('returns the generic set when no model is given (response nodes)', () => {
        const info = getThinkingLevelInfo(undefined)
        expect(info.vendor).toBe('generic')
        expect(info.options.map(o => o.value)).toEqual(['none', 'low', 'medium', 'high'])
    })

    it('maps gpt-5 models to reasoning_effort including minimal for none', () => {
        const info = getThinkingLevelInfo('gpt-5-mini')
        expect(info.vendor).toBe('openai')
        expect(info.options.find(o => o.value === 'none')?.native).toContain('minimal')
        expect(info.options).toHaveLength(4)
    })

    it('omits the none level for o-series models', () => {
        const info = getThinkingLevelInfo('o3-mini')
        expect(info.vendor).toBe('openai')
        expect(info.options.map(o => o.value)).toEqual(['low', 'medium', 'high'])
    })

    it('marks non-reasoning OpenAI models unsupported', () => {
        expect(getThinkingLevelInfo('gpt-4o').vendor).toBe('unsupported')
        expect(getThinkingLevelInfo('gpt-4o').options).toHaveLength(0)
    })

    it('offers adaptive thinking + effort for Claude 4.6+/5 families', () => {
        const info = getThinkingLevelInfo('claude-sonnet-4-6')
        expect(info.vendor).toBe('anthropic')
        expect(info.options.find(o => o.value === 'high')?.native).toContain('effort: high')
    })

    it('marks pre-adaptive Claude models unsupported', () => {
        expect(getThinkingLevelInfo('claude-haiku-4-5').vendor).toBe('unsupported')
        expect(getThinkingLevelInfo('claude-sonnet-4-5').vendor).toBe('unsupported')
    })

    it('maps gemini 2.5 to thinking budgets, with a floor for 2.5 Pro', () => {
        const flash = getThinkingLevelInfo('gemini-2.5-flash')
        expect(flash.vendor).toBe('gemini')
        expect(flash.options.find(o => o.value === 'none')?.native).toContain('0')
        const pro = getThinkingLevelInfo('gemini-2.5-pro')
        expect(pro.options.find(o => o.value === 'none')?.native).toContain('128')
    })

    it('maps gemini 3 to thinking levels', () => {
        const info = getThinkingLevelInfo('gemini-3-pro-preview')
        expect(info.vendor).toBe('gemini')
        expect(info.options.find(o => o.value === 'none')?.native).toContain('minimal')
    })

    it('falls back to the generic set for unknown vendors', () => {
        expect(getThinkingLevelInfo('mistral-large-latest').vendor).toBe('generic')
    })
})
