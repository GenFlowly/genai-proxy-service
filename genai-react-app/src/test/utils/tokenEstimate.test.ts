import { estimateTokens } from '../../utils/tokenEstimate';

describe('estimateTokens', () => {
    it('returns 0 for empty text', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('estimates ~4 characters per token for latin text', () => {
        expect(estimateTokens('abcd')).toBe(1);
        expect(estimateTokens('abcde')).toBe(2);
        expect(estimateTokens('Hello World')).toBe(3); // 11 chars
    });

    it('counts CJK characters as one token each', () => {
        expect(estimateTokens('你好世界')).toBe(4);
        expect(estimateTokens('こんにちは')).toBe(5);
        expect(estimateTokens('안녕하세요')).toBe(5);
    });

    it('handles mixed CJK and latin text', () => {
        // 2 CJK chars + ' hi' (3 chars → 1 token)
        expect(estimateTokens('你好 hi')).toBe(3);
    });

    it('scales linearly for long text', () => {
        expect(estimateTokens('a'.repeat(4000))).toBe(1000);
    });
});
