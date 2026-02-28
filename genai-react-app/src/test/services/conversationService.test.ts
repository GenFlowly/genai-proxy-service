import { getConversation } from '../../services/conversationService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { config } from '../../config/env';
import { AIVendor } from '../../constants/vendors';

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('conversationService', () => {
    const mockToken = 'mock-token';
    const mockConversationId = 'conv-123';
    const mockUrl = `${config.backend.baseUrl}/api/v1/chat/${mockConversationId}`;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('getConversation returns mapped conversation data on success', async () => {
        // Arrange
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Hello' },
                    response: {
                        text: 'World',
                        aiVendor: 'OPENAI',
                        conversationId: mockConversationId,
                        messageId: 'msg-1'
                    }
                },
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Question' },
                    response: {
                        text: 'Answer',
                        aiVendor: 'CLAUDE',
                        conversationId: mockConversationId,
                        messageId: 'msg-2'
                    }
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

    test('getConversation handles missing response text gracefully', async () => {
        // Arrange: One valid item, one incomplete item
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Valid' },
                    response: { text: null, aiVendor: null, conversationId: null, messageId: null }
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

    test('getConversation maps unknown vendor to default (OPENAI)', async () => {
        const mockBackendResponse = {
            promptAndResponseList: [
                {
                    prompt: { instructionId: '', instructionVersion: '', prompt: 'Hello' },
                    response: {
                        text: 'World',
                        aiVendor: null, // No vendor
                        conversationId: mockConversationId,
                        messageId: 'msg-1'
                    }
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
});
