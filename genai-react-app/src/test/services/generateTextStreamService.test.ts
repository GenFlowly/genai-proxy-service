import { generateTextStream } from '../../services/generateTextStreamService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import { mockGenerateTextStreamRequest } from '../fixtures/generateText';
import { GenerateTextStreamRequest } from '../../models/generateText.models';

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('generateTextStreamService', () => {
    const mockToken = 'mock-auth-token';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('generateTextStream reads stream, calls onDelta, and calls onMetadata', async () => {
        // Arrange
        const encoder = new TextEncoder();
        const chunk1 = encoder.encode('Hel');
        const chunk2 = encoder.encode('lo');

        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: chunk1 })
                .mockResolvedValueOnce({ done: false, value: chunk2 })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };

        const mockHeaders = new Map();
        mockHeaders.set('X-Conversation-Id', 'conv-123');
        mockHeaders.set('X-Message-Id', 'msg-new');
        mockHeaders.set('X-Response-Message-Id', 'resp-new');
        mockHeaders.set('X-Ai-Vendor', 'OPENAI');

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: mockHeaders,
            body: {
                getReader: () => mockReader
            }
        });

        const onDelta = jest.fn();
        const onMetadata = jest.fn();

        // Act
        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta,
            onMetadata
        );

        // Assert API Call
        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.generateTextStream, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
            body: JSON.stringify(mockGenerateTextStreamRequest),
        });

        // Assert Metadata
        expect(onMetadata).toHaveBeenCalledWith({
            conversationId: 'conv-123',
            messageId: 'msg-new',
            responseMessageId: 'resp-new',
            aiVendor: 'OPENAI',
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            tokensReadFromCache: null
        });

        // Assert Stream Chunks
        expect(onDelta).toHaveBeenCalledTimes(2);
        expect(onDelta).toHaveBeenNthCalledWith(1, 'Hel');
        expect(onDelta).toHaveBeenNthCalledWith(2, 'lo');

        // Assert Cleanup
        expect(mockReader.releaseLock).toHaveBeenCalled();
    });

    test('generateTextStream extracts USAGE sentinel and fires second onMetadata', async () => {
        const encoder = new TextEncoder();
        const chunk1 = encoder.encode('Hel');
        const chunk2 = encoder.encode('lo\n[USAGE:{"inputTokens":123,"outputTokens":456,"totalTokens":579,"tokensReadFromCache":100}]');

        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: chunk1 })
                .mockResolvedValueOnce({ done: false, value: chunk2 })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };

        const mockHeaders = new Map();
        mockHeaders.set('X-Conversation-Id', 'conv-123');
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: mockHeaders,
            body: { getReader: () => mockReader }
        });

        const onDelta = jest.fn();
        const onMetadata = jest.fn();

        await generateTextStream(mockToken, mockGenerateTextStreamRequest as GenerateTextStreamRequest, onDelta, onMetadata);

        expect(onMetadata).toHaveBeenCalledTimes(2);

        // First call (from headers)
        expect(onMetadata).toHaveBeenNthCalledWith(1, expect.objectContaining({
            conversationId: 'conv-123',
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            tokensReadFromCache: null
        }));

        // Second call (from sentinel)
        expect(onMetadata).toHaveBeenNthCalledWith(2, expect.objectContaining({
            conversationId: 'conv-123',
            inputTokens: 123,
            outputTokens: 456,
            totalTokens: 579,
            tokensReadFromCache: 100
        }));

        // Delta should ONLY get "Hel" and "lo", and NOT the sentinel text
        expect(onDelta).toHaveBeenCalledTimes(2);
        expect(onDelta).toHaveBeenNthCalledWith(1, 'Hel');
        expect(onDelta).toHaveBeenNthCalledWith(2, 'lo');
    });

    test('generateTextStream throws error on non-ok response', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 400,
            statusText: 'Bad Request'
        });

        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            jest.fn()
        )).rejects.toThrow('Text generation failed: 400 Bad Request');
    });

    test('generateTextStream throws error if response body is missing', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: new Map(),
            body: null // No body
        });

        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            jest.fn()
        )).rejects.toThrow('Response body is not readable');
    });

    test('generateTextStream handles stream errors', async () => {
        const mockReader = {
            read: jest.fn().mockRejectedValue(new Error('Stream Error')),
            releaseLock: jest.fn()
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: new Map(),
            body: {
                getReader: () => mockReader
            }
        });

        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            jest.fn()
        )).rejects.toThrow('Stream Error');

        expect(mockReader.releaseLock).toHaveBeenCalled();
    });
});
