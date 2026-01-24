import { getTokenizer, countTokens, clearTokenizerCache } from '../../utils/tokenizer';
import * as tiktoken from 'js-tiktoken';

// Mock the js-tiktoken library
jest.mock('js-tiktoken', () => ({
    encodingForModel: jest.fn(),
}));

describe('tokenizer utils', () => {
    const mockEncode = jest.fn();
    const mockEncodingForModel = tiktoken.encodingForModel as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        clearTokenizerCache();
        mockEncode.mockReturnValue([1, 2, 3]); // Default 3 tokens
        mockEncodingForModel.mockReturnValue({
            encode: mockEncode,
            free: jest.fn(),
        });
    });

    describe('getTokenizer', () => {
        it('should throw if model is missing', async () => {
            await expect(getTokenizer('')).rejects.toThrow('getTokenizer: model string is required');
        });

        it('should load tokenizer for valid model', async () => {
            const tokenizer = await getTokenizer('gpt-4');
            expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4');
            expect(tokenizer).toBeDefined();
        });

        it('should cache the tokenizer', async () => {
            await getTokenizer('gpt-4');
            await getTokenizer('gpt-4');
            expect(mockEncodingForModel).toHaveBeenCalledTimes(1);
        });

        it('should load different tokenizers for different models', async () => {
            await getTokenizer('gpt-4');
            await getTokenizer('gpt-3.5-turbo');
            expect(mockEncodingForModel).toHaveBeenCalledTimes(2);
        });
    });

    describe('countTokens', () => {
        it('should return 0 for empty text', async () => {
            const count = await countTokens('', 'gpt-4');
            expect(count).toBe(0);
            expect(mockEncode).not.toHaveBeenCalled();
        });

        it('should throw if model is missing', async () => {
            await expect(countTokens('hello', '')).rejects.toThrow('No model selected');
        });

        it('should return correct token count', async () => {
            mockEncode.mockReturnValue([10, 20, 30, 40]);
            const count = await countTokens('hello world', 'gpt-4');
            expect(count).toBe(4);
            expect(mockEncode).toHaveBeenCalledWith('hello world');
        });

        it('should reuse cached tokenizer', async () => {
            await countTokens('test1', 'gpt-4');
            await countTokens('test2', 'gpt-4');
            expect(mockEncodingForModel).toHaveBeenCalledTimes(1);
        });
    });
});
