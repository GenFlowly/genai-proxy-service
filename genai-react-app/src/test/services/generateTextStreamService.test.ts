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



    test('generateTextStream parses "ks" structured thinking steps and still supports legacy "k" strings', async () => {
        const encoder = new TextEncoder();
        const runningStep = {
            node: 'query_analyzer',
            name: 'Query Analyzer',
            kind: 'LLM',
            status: 'running',
            label: 'Query Analyzer: thinking…'
        };
        const doneStep = {
            node: 'query_analyzer',
            name: 'Query Analyzer',
            kind: 'LLM',
            status: 'done',
            detail: 'Intent: lookup (needs rewrite: no)',
            items: ['Doc A', 'Doc B'],
            prompt: 'rendered prompt',
            response: 'raw model response'
        };
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode(`{"t":"ks","v":${JSON.stringify(runningStep)}}\n`) })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"k","v":"legacy flat step"}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode(`{"t":"ks","v":${JSON.stringify(doneStep)}}\n`) })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"Answer"}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: new Map(),
            body: { getReader: () => mockReader }
        });

        const onDelta = jest.fn();
        const onThinking = jest.fn();
        const onThinkingStep = jest.fn();

        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta,
            undefined,
            onThinking,
            undefined,
            undefined,
            undefined,
            onThinkingStep
        );

        expect(onThinkingStep).toHaveBeenCalledTimes(2);
        expect(onThinkingStep).toHaveBeenNthCalledWith(1, runningStep);
        expect(onThinkingStep).toHaveBeenNthCalledWith(2, doneStep);
        // Legacy flat strings keep flowing through onThinking, not onThinkingStep
        expect(onThinking).toHaveBeenCalledTimes(1);
        expect(onThinking).toHaveBeenCalledWith('legacy flat step');
        // Steps never leak into the answer text
        expect(onDelta).toHaveBeenCalledTimes(1);
        expect(onDelta).toHaveBeenCalledWith('Answer');
    });

    test('generateTextStream ignores malformed "ks" payloads', async () => {
        const encoder = new TextEncoder();
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"ks","v":"not an object"}\n{"t":"ks","v":{"name":"missing node id"}}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: new Map(),
            body: { getReader: () => mockReader }
        });

        const onThinkingStep = jest.fn();
        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            jest.fn(),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            onThinkingStep
        );

        expect(onThinkingStep).not.toHaveBeenCalled();
    });

    test('generateTextStream normalizes "ga" generated-attachment chunks into AttachmentRefs', async () => {
        const encoder = new TextEncoder();
        const gaPayload = [
            {
                artifact_id: 'abc-123',
                key: 'customers/CU1/attachments/abc-123',
                media_type: 'application/pdf',
                filename: 'report.pdf',
                size_bytes: 15417
            },
            { filename: 'no-id-so-dropped.pdf' }
        ];
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode(`{"t":"ga","v":${JSON.stringify(gaPayload)}}\n`) })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"Your PDF is ready"}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: new Map(),
            body: { getReader: () => mockReader }
        });

        const onDelta = jest.fn();
        const onGeneratedAttachments = jest.fn();
        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            onGeneratedAttachments
        );

        expect(onGeneratedAttachments).toHaveBeenCalledTimes(1);
        expect(onGeneratedAttachments).toHaveBeenCalledWith([
            {
                attachmentId: 'abc-123',
                s3Key: 'customers/CU1/attachments/abc-123',
                mediaType: 'application/pdf',
                filename: 'report.pdf',
                sizeBytes: 15417
            }
        ]);
        // Attachment chunks never leak into the answer text
        expect(onDelta).toHaveBeenCalledTimes(1);
        expect(onDelta).toHaveBeenCalledWith('Your PDF is ready');
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

    test('generateTextStream throws the vendor reason on a structured "err" chunk', async () => {
        const encoder = new TextEncoder();
        const reason = 'Rate limit or quota exceeded (gemini): You exceeded your current quota, limit: 20';
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"partial "}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode(`${JSON.stringify({ t: 'err', v: reason })}\n`) })
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
        )).rejects.toThrow(reason);

        // Partial text delivered; the error payload never leaks into the text
        expect(onDelta).toHaveBeenCalledWith('partial ');
        expect(onDelta).not.toHaveBeenCalledWith(expect.stringContaining('quota'));
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
