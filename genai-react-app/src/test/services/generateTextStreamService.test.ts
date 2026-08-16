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
        const chunk1 = encoder.encode('{"t":"c","v":"Hel"}\n');
        const chunk2 = encoder.encode('{"t":"c","v":"lo"}\n');

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

    test('generateTextStream surfaces the error reason from a JSON error body', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: jest.fn().mockResolvedValue('{"error":"API key not found for vendor: CLAUDE"}')
        });

        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            jest.fn()
        )).rejects.toThrow('API key not found for vendor: CLAUDE (HTTP 500)');
    });

    test('generateTextStream keeps streamed deltas and throws on a mid-stream [Error:] line', async () => {
        const encoder = new TextEncoder();
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"partial "}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('\n\n[Error: Rate limit exceeded]\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: new Map(),
            body: { getReader: () => mockReader }
        });

        const onDelta = jest.fn();
        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta
        )).rejects.toThrow('Rate limit exceeded');

        // The text streamed before the failure was still delivered
        expect(onDelta).toHaveBeenCalledWith('partial ');
        expect(onDelta).not.toHaveBeenCalledWith(expect.stringContaining('[Error:'));
        expect(mockReader.releaseLock).toHaveBeenCalled();
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

    test('generateTextStream throws when response is not ok', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
        });

        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            jest.fn()
        )).rejects.toThrow('Session expired');
    });
});
// Trigger coverage run
// Trigger coverage run
