import { generateTextStream, readNdjsonStream, StreamGenerationError, StreamTruncatedError, STOP_REASON_CANCELLED } from '../../services/generateTextStreamService';
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
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"done","status":"ok"}\n') })
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



    test('generateTextStream relays "ac" activity events in order and never into the text', async () => {
        const encoder = new TextEncoder();
        const start = { v: 2, at: 0, type: 'turn.start' };
        const stepStart = { v: 2, at: 120, type: 'step.start', id: 'g:1', kind: 'llm', node: 'g', name: 'Agent' };
        const stepEnd = {
            v: 2, at: 900, type: 'step.end', id: 'g:1', kind: 'llm', node: 'g', name: 'Agent',
            duration_ms: 780, outcome: 'answer',
        };
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode(`{"t":"ac","v":${JSON.stringify(start)}}\n`) })
                .mockResolvedValueOnce({ done: false, value: encoder.encode(`{"t":"ac","v":${JSON.stringify(stepStart)}}\n`) })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"Answer"}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode(`{"t":"ac","v":${JSON.stringify(stepEnd)}}\n`) })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"done","status":"ok"}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: new Map(),
            body: { getReader: () => mockReader }
        });

        const onDelta = jest.fn();
        const onActivity = jest.fn();

        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta,
            undefined,
            onActivity
        );

        expect(onActivity.mock.calls.map(c => c[0])).toEqual([start, stepStart, stepEnd]);
        expect(onDelta).toHaveBeenCalledTimes(1);
        expect(onDelta).toHaveBeenCalledWith('Answer');
    });

    test('generateTextStream ignores malformed and retired thinking frames', async () => {
        const encoder = new TextEncoder();
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"ac","v":"not an object"}\n{"t":"ac","v":{"v":1,"type":"turn.start"}}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"ks","v":{"node":"n","status":"running"}}\n{"t":"k","v":"flat"}\n{"t":"kd","v":1200}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"done","status":"ok"}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            headers: new Map(),
            body: { getReader: () => mockReader }
        });

        const onDelta = jest.fn();
        const onActivity = jest.fn();
        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta,
            undefined,
            onActivity
        );

        expect(onActivity).not.toHaveBeenCalled();
        expect(onDelta).not.toHaveBeenCalled();
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
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"done","status":"ok"}\n') })
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

    test('generateTextStream shows a content-rules refusal as written, without a status code', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 422,
            statusText: 'Unprocessable Entity',
            text: jest.fn().mockResolvedValue('{"error":"This can\'t be posted.","code":"CONTENT_BLOCKED"}')
        });

        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            jest.fn()
        )).rejects.toThrow(/^This can't be posted\.$/);
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
        const error = await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta
        ).catch(e => e);

        // The server's own report of a failure, not a lost connection
        expect(error).toBeInstanceOf(StreamGenerationError);
        expect(error.message).toBe('Rate limit exceeded');

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
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"done","status":"ok"}\n') })
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
            undefined, undefined, undefined, undefined, undefined,
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
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"done","status":"ok"}\n') })
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
            undefined, undefined, undefined, undefined, undefined,
            undefined,
            onContentReset
        );

        expect(onContentReset).toHaveBeenCalledTimes(1);
        // The reset arrived between the preamble and the final answer
        expect(seen).toEqual(['delta:Let me search.', 'reset', 'delta:The answer is 9.']);
        expect(text).toBe('The answer is 9.');
    });

    test('generateTextStream throws StreamGenerationError on a done:error terminal frame', async () => {
        const encoder = new TextEncoder();
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"partial "}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"done","status":"error","m":"Connection to the retrieval server was lost mid-response."}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };
        mockFetchWithRetry.mockResolvedValue({ ok: true, headers: new Map(), body: { getReader: () => mockReader } });

        const onDelta = jest.fn();
        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta
        )).rejects.toThrow(StreamGenerationError);
        expect(onDelta).toHaveBeenCalledWith('partial ');
    });

    test('generateTextStream reports a done:cancelled terminal frame as the cancelled stop reason', async () => {
        const encoder = new TextEncoder();
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"partial "}\n') })
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"done","status":"cancelled"}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };
        mockFetchWithRetry.mockResolvedValue({ ok: true, headers: new Map(), body: { getReader: () => mockReader } });

        const onStopReason = jest.fn();
        await generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            jest.fn(),
            undefined, undefined, undefined, undefined, undefined,
            undefined, undefined,
            onStopReason
        );

        expect(onStopReason).toHaveBeenCalledWith(STOP_REASON_CANCELLED);
    });

    test('generateTextStream throws StreamTruncatedError when the body closes with no done frame', async () => {
        const encoder = new TextEncoder();
        const mockReader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: encoder.encode('{"t":"c","v":"partial "}\n') })
                // Connection dropped: no "done" frame, just end of stream.
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn()
        };
        mockFetchWithRetry.mockResolvedValue({ ok: true, headers: new Map(), body: { getReader: () => mockReader } });

        const onDelta = jest.fn();
        await expect(generateTextStream(
            mockToken,
            mockGenerateTextStreamRequest as GenerateTextStreamRequest,
            onDelta
        )).rejects.toThrow(StreamTruncatedError);
        expect(onDelta).toHaveBeenCalledWith('partial ');
    });
});
// Trigger coverage run
// Trigger coverage run

describe('readNdjsonStream, resuming a durable run', () => {
    const responseOf = (lines: string[]) => {
        const encoder = new TextEncoder();
        const read = jest.fn();
        lines.forEach(line => read.mockResolvedValueOnce({ done: false, value: encoder.encode(line + '\n') }));
        read.mockResolvedValueOnce({ done: true });
        return { body: { getReader: () => ({ read, releaseLock: jest.fn() }) } } as unknown as Response;
    };

    test('the run frame names the run and its clock', async () => {
        const onRun = jest.fn();
        const onSeq = jest.fn();
        await readNdjsonStream(responseOf([
            '{"t":"run","v":"run_1","s":4,"ms":41250}',
            '{"t":"done","status":"ok","s":4}',
        ]), { onDelta: jest.fn(), onRun, onSeq });
        expect(onRun).toHaveBeenCalledWith('run_1', 41250);
        expect(onSeq).toHaveBeenCalledWith(4);
    });

    test('each frame commits its seq after it is applied', async () => {
        const order: string[] = [];
        await readNdjsonStream(responseOf([
            '{"t":"c","v":"Hel","s":5}',
            '{"t":"c","v":"lo","s":6}',
            '{"t":"done","status":"ok","s":6}',
        ]), { onDelta: c => order.push(c), onSeq: s => order.push(`s${s}`) });
        expect(order).toEqual(['Hel', 's5', 'lo', 's6', 's6']);
    });

    test('an error frame does not commit its seq', async () => {
        const onSeq = jest.fn();
        await expect(readNdjsonStream(responseOf(['{"t":"err","v":"quota","s":9}']), { onDelta: jest.fn(), onSeq }))
            .rejects.toBeInstanceOf(StreamGenerationError);
        expect(onSeq).not.toHaveBeenCalled();
    });
});
