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

    test('generateTextStream surfaces an "ai" awaiting_input frame via onAwaitingInput', async () => {
        const encoder = new TextEncoder();
        const payload = { type: 'human_input', node: 'HITL', prompt: 'Approve?', run_id: 'r1' };
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode(`{"t":"ai","v":${JSON.stringify(payload)}}\n`) })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"resumed"}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn(),
        };
        mockFetchWithRetry.mockResolvedValue({ ok: true, headers: new Map(), body: { getReader: () => mockReader } });

        const onDelta = jest.fn();
        const onAwaitingInput = jest.fn();
        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onAwaitingInput
        );

        expect(onAwaitingInput).toHaveBeenCalledWith(payload);
        // Content after the pause still flows through as normal text
        expect(onDelta).toHaveBeenCalledWith('resumed');
    });

    test('generateTextStream surfaces a "cr" content-reset frame between tool rounds', async () => {
        // A tool-calling round streams a preamble, then "cr" says discard it —
        // only the final round's text is the answer.
        const encoder = new TextEncoder();
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"Let me search."}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"cr"}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"The answer is 9."}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn(),
        };
        mockFetchWithRetry.mockResolvedValue({ ok: true, headers: new Map(), body: { getReader: () => mockReader } });

        const seen: string[] = [];
        let text = '';
        const onDelta = jest.fn((c: string) => { text += c; seen.push(`delta:${c}`); });
        const onContentReset = jest.fn(() => { text = ''; seen.push('reset'); });
        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            undefined,
            onContentReset
        );

        expect(onContentReset).toHaveBeenCalledTimes(1);
        // The reset arrived between the preamble and the final answer
        expect(seen).toEqual(['delta:Let me search.', 'reset', 'delta:The answer is 9.']);
        expect(text).toBe('The answer is 9.');
    });

    describe('"pg" progress frames', () => {
        const streamOf = (...lines: string[]) => {
            const encoder = new TextEncoder();
            const read = jest.fn();
            lines.forEach(line => read.mockResolvedValueOnce({ done: false, value: encoder.encode(`${line}\n`) }));
            read.mockResolvedValueOnce({ done: true });
            mockFetchWithRetry.mockResolvedValue({
                ok: true,
                headers: new Map(),
                body: { getReader: () => ({ read, releaseLock: jest.fn() }) },
            });
        };
        const run = (onDelta: jest.Mock, onProgress: jest.Mock, onGeneratedAttachments?: jest.Mock) =>
            generateTextStream(
                mockToken,
                mockGenerateTextStreamRequest as GenerateTextStreamRequest,
                onDelta,
                undefined, undefined, undefined, undefined, undefined, undefined,
                onGeneratedAttachments,
                undefined, undefined, undefined,
                onProgress
            );

        test('relays growing progress and clears it on the next content frame', async () => {
            streamOf(
                '{"t":"c","v":"I\'ll write the report."}',
                '{"t":"pg","v":{"tool":"generate_pdf","chars":1200}}',
                '{"t":"pg","v":{"tool":"generate_pdf","chars":5400}}',
                '{"t":"c","v":" Done."}',
            );
            const events: unknown[] = [];
            const onDelta = jest.fn((c: string) => events.push(`delta:${c}`));
            const onProgress = jest.fn(p => events.push(p));

            await run(onDelta, onProgress);

            expect(events).toEqual([
                "delta:I'll write the report.",
                { tool: 'generate_pdf', chars: 1200 },
                { tool: 'generate_pdf', chars: 5400 },
                null,
                'delta: Done.',
            ]);
        });

        test('a generated file clears the progress line', async () => {
            streamOf(
                '{"t":"pg","v":{"tool":"revise_pdf","chars":900}}',
                '{"t":"ga","v":[{"artifact_id":"a1","media_type":"application/pdf","filename":"r.pdf","size_bytes":10}]}',
            );
            const events: unknown[] = [];
            const onProgress = jest.fn(p => events.push(p));
            const onGeneratedAttachments = jest.fn(() => events.push('ga'));

            await run(jest.fn(), onProgress, onGeneratedAttachments);

            expect(events).toEqual([{ tool: 'revise_pdf', chars: 900 }, null, 'ga']);
        });

        test('an "err" frame clears the progress line before the failure surfaces', async () => {
            streamOf(
                '{"t":"pg","v":{"tool":"fs_write","chars":300}}',
                '{"t":"err","v":"The response was lost"}',
            );
            jest.spyOn(console, 'error').mockImplementation(() => {});
            const onProgress = jest.fn();

            await expect(run(jest.fn(), onProgress)).rejects.toThrow('The response was lost');
            expect(onProgress.mock.calls).toEqual([[{ tool: 'fs_write', chars: 300 }], [null]]);
        });

        test('the end of the stream clears it; no clear is sent when nothing was shown', async () => {
            streamOf('{"t":"pg","v":{"tool":"generate_pdf","chars":77}}');
            const onProgress = jest.fn();
            await run(jest.fn(), onProgress);
            expect(onProgress.mock.calls).toEqual([[{ tool: 'generate_pdf', chars: 77 }], [null]]);

            streamOf('{"t":"c","v":"Plain answer"}');
            const quiet = jest.fn();
            await run(jest.fn(), quiet);
            expect(quiet).not.toHaveBeenCalled();
        });

        test('malformed progress frames are ignored', async () => {
            streamOf(
                '{"t":"pg","v":{"chars":10}}',
                '{"t":"pg","v":{"tool":"generate_pdf","chars":"lots"}}',
                '{"t":"pg","v":null}',
                '{"t":"c","v":"ok"}',
            );
            const onDelta = jest.fn();
            const onProgress = jest.fn();
            await run(onDelta, onProgress);
            expect(onProgress).not.toHaveBeenCalled();
            expect(onDelta).toHaveBeenCalledWith('ok');
        });
    });
});
// Trigger coverage run
// Trigger coverage run
