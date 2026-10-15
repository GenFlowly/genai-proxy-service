import {
    getConversation,
    shareConversation,
    unshareConversation,
    getConversationSharedUsers,
} from '../../services/conversationService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { config } from '../../config/env';
import { AIVendor } from '../../constants/vendors';
import { endpoints } from '../../config/endpoints';

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('conversationService', () => {
    const mockToken = 'mock-token';
    const mockConversationId = 'conv-123';
    const mockUrl = `${config.backend.baseUrl}/api/v1/chat?conversationId=${mockConversationId}`;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('getConversation returns mapped conversation data on success', async () => {
        // Arrange
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Hello' },
                    responses: [{
                        text: 'World',
                        aiVendor: 'OPENAI',
                        conversationId: mockConversationId,
                        messageId: 'msg-1'
                    }]
                },
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Question' },
                    responses: [{
                        text: 'Answer',
                        aiVendor: 'CLAUDE',
                        conversationId: mockConversationId,
                        messageId: 'msg-2'
                    }]
                }
            ]
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        // Act
        const result = await getConversation(mockToken, mockConversationId);

        // Assert
        expect(mockFetchWithRetry).toHaveBeenCalledWith(mockUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${mockToken}`,
                'Content-Type': 'application/json',
            },
        });

        expect(result).not.toBeNull();
        expect(result?.conversationId).toBe(mockConversationId);
        expect(result?.blocks).toHaveLength(2);

        // Verify mapping of first block
        expect(result?.blocks[0].prompt).toBe('Hello');
        expect(result?.blocks[0].responseMessages).toHaveLength(1);
        expect(result?.blocks[0].responseMessages[0].text).toBe('World');
        expect(result?.blocks[0].responseMessages[0].aiVendor).toBe(AIVendor.OPENAI);
        expect(result?.blocks[0].conversationBlockId).toBe('block-msg-1'); // From logic

        // Verify mapping of second block
        expect(result?.blocks[1].prompt).toBe('Question');
        expect(result?.blocks[1].responseMessages[0].aiVendor).toBe(AIVendor.CLAUDE); // Although backend string "CLAUDE" needs to match enum if mapped correctly or cast
    });

    test('getConversation maps the per-message sender onto blocks', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'From the owner' },
                    responses: [{ text: 'Hi', aiVendor: 'OPENAI', conversationId: mockConversationId, messageId: 'msg-1' }],
                    sender: { customerId: 'cust-owner', name: 'Owner Name', picture: 'https://pics/owner.png' }
                },
                {
                    // Older server / legacy record: no sender field
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'No sender' },
                    responses: [{ text: 'Ok', aiVendor: 'OPENAI', conversationId: mockConversationId, messageId: 'msg-2' }]
                }
            ]
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        const result = await getConversation(mockToken, mockConversationId);

        expect(result?.blocks[0].sender).toEqual({
            customerId: 'cust-owner',
            name: 'Owner Name',
            picture: 'https://pics/owner.png'
        });
        expect(result?.blocks[1].sender).toBeUndefined();
    });

    test('getConversation handles missing response text gracefully', async () => {
        // Arrange: One valid item, one incomplete item
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Valid' },
                    responses: [{ text: null, aiVendor: null, conversationId: null, messageId: null }]
                }
            ]
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        // Act
        const result = await getConversation(mockToken, mockConversationId);

        // Assert
        expect(result?.blocks).toHaveLength(1);
        expect(result?.blocks[0].prompt).toBe('Valid');
        expect(result?.blocks[0].responseMessages).toHaveLength(0); // Should be empty
    });

    test('getConversation keeps a failed turn and its error, with or without text', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Write the report' },
                    responses: [
                        // Failed before any text (e.g. the durable run was lost)
                        { text: '', aiVendor: 'CLAUDE', conversationId: mockConversationId, messageId: 'msg-f1',
                          error: 'The response was lost when the server restarted.' },
                        // Failed after some text streamed
                        { text: 'The first half', aiVendor: 'OPENAI', conversationId: mockConversationId, messageId: 'msg-f2',
                          error: 'Provider quota exceeded' },
                    ]
                }
            ]
        };
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        const result = await getConversation(mockToken, mockConversationId);

        const [noText, partial] = result!.blocks[0].responseMessages;
        expect(noText).toMatchObject({
            messageId: 'msg-f1',
            text: '',
            isLoading: false,
            error: 'The response was lost when the server restarted.',
        });
        expect(partial).toMatchObject({
            messageId: 'msg-f2',
            text: 'The first half',
            error: 'Provider quota exceeded',
        });
        // A successful turn carries no error field at all
        expect(result!.blocks[0].responseMessages).toHaveLength(2);
    });

    test('getConversation adds no error to successful turns', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                promptAndResponseList: [{
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Hi' },
                    responses: [{ text: 'Hello', aiVendor: 'OPENAI', conversationId: mockConversationId, messageId: 'm1', error: null }]
                }]
            })
        });
        const result = await getConversation(mockToken, mockConversationId);
        expect(result!.blocks[0].responseMessages[0]).not.toHaveProperty('error');
    });

    test('getConversation throws error on non-ok response', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 404,
            statusText: 'Not Found'
        });

        // Act & Assert
        await expect(getConversation(mockToken, mockConversationId))
            .rejects.toThrow('Failed to fetch conversation: 404 Not Found');
    });

    test('getConversation attaches status to thrown error', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden'
        });

        let caughtError: any;
        try {
            await getConversation(mockToken, mockConversationId);
        } catch (err) {
            caughtError = err;
        }

        expect(caughtError).toBeDefined();
        expect(caughtError.status).toBe(403);
        expect(caughtError.message).toContain('403');
    });

    test('getConversation returns title from response', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [],
            title: 'My Conversation'
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        const result = await getConversation(mockToken, mockConversationId);

        expect(result?.title).toBe('My Conversation');
        expect(result?.blocks).toHaveLength(0);
    });

    test('getConversation handles block with no responses', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Hello' },
                    responses: []
                }
            ]
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        const result = await getConversation(mockToken, mockConversationId);

        expect(result?.blocks).toHaveLength(1);
        expect(result?.blocks[0].responseMessages).toHaveLength(0);
        expect(result?.blocks[0].prompt).toBe('Hello');
    });

    test('getConversation returns instructionId from the latest prompt that has one', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: 'INS-abc123', instructionVersion: '5', prompt: 'Hello' },
                    responses: [{ text: 'Hi', aiVendor: 'OPENAI', conversationId: mockConversationId, messageId: 'msg-1' }]
                },
                {
                    prompt: { instructionId: 'INS-other', instructionVersion: '1', prompt: 'Second' },
                    responses: []
                }
            ]
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        const result = await getConversation(mockToken, mockConversationId);

        // The most recent prompt with an instruction wins
        expect(result?.instructionId).toBe('INS-other');
    });

    test('getConversation skips trailing prompts with blank instructionId', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'No instruction yet' },
                    responses: []
                },
                {
                    prompt: { instructionId: 'INS-abc123', instructionVersion: '5', prompt: 'With instruction' },
                    responses: []
                },
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Blank again' },
                    responses: []
                }
            ]
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        const result = await getConversation(mockToken, mockConversationId);

        // Blank instructionIds never win over an earlier real one
        expect(result?.instructionId).toBe('INS-abc123');
    });

    test('getConversation returns null instructionId when promptAndResponseList is empty', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [],
            title: 'Empty Chat'
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        const result = await getConversation(mockToken, mockConversationId);

        expect(result?.instructionId).toBeNull();
    });

    test('getConversation maps unknown vendor to default (OPENAI)', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Hello' },
                    responses: [{
                        text: 'World',
                        aiVendor: null, // No vendor
                        conversationId: mockConversationId,
                        messageId: 'msg-1'
                    }]
                }
            ]
        };

        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockBackendResponse)
        });

        const result = await getConversation(mockToken, mockConversationId);

        expect(result?.blocks[0].responseMessages[0].aiVendor).toBe(AIVendor.OPENAI);
    });

    test('shareConversation posts the share payload', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });

        await shareConversation(mockToken, mockConversationId, 'cust-9', 'EDIT');

        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.conversationShare, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${mockToken}`,
            },
            body: JSON.stringify({
                conversationId: mockConversationId,
                targetCustomerId: 'cust-9',
                role: 'EDIT',
            }),
        });
    });

    test('shareConversation throws on non-ok response', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });

        await expect(shareConversation(mockToken, mockConversationId, 'cust-9'))
            .rejects.toThrow('Share Conversation failed: 403 Forbidden');
    });

    test('unshareConversation deletes with query params', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });

        await unshareConversation(mockToken, mockConversationId, 'cust-9');

        expect(mockFetchWithRetry).toHaveBeenCalledWith(
            `${endpoints.conversationShare}?conversationId=${mockConversationId}&targetCustomerId=cust-9`,
            expect.objectContaining({ method: 'DELETE' })
        );
    });

    test('unshareConversation throws on non-ok response', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

        await expect(unshareConversation(mockToken, mockConversationId, 'cust-9'))
            .rejects.toThrow('Unshare Conversation failed: 404 Not Found');
    });

    test('getConversationSharedUsers returns the user list', async () => {
        const users = [{ customerId: 'cust-9', username: 'sam' }];
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(users),
        });

        const result = await getConversationSharedUsers(mockToken, mockConversationId);

        expect(mockFetchWithRetry).toHaveBeenCalledWith(
            endpoints.conversationSharedUsers(mockConversationId),
            expect.objectContaining({ method: 'GET' })
        );
        expect(result).toEqual(users);
    });

    test('getConversationSharedUsers throws on non-ok response', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

        await expect(getConversationSharedUsers(mockToken, mockConversationId))
            .rejects.toThrow('Get Conversation Shared Users failed: 500 Internal Server Error');
    });
});
// Trigger coverage run
// Trigger coverage run
