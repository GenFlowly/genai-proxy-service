// Fast approximation of GPT-style BPE token counts without shipping the
// multi-megabyte encoder tables:
// - CJK scripts tokenize at roughly one token per character
// - everything else averages ~4 characters per token (English prose and code)
// Typically within ~15% of tiktoken for prose — enough for the sidebar's
// "Estimated" display.

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g

export function estimateTokens(text: string): number {
    if (!text) return 0
    const cjkCount = text.match(CJK)?.length ?? 0
    const restLength = text.length - cjkCount
    return cjkCount + Math.ceil(restLength / 4)
}
