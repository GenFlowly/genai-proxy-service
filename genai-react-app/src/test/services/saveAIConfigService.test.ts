import { saveAIConfigPreferences, SaveAIConfigPreferencesRequest } from '../../services/saveAIConfigService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import { AIVendor } from '../../constants/vendors';

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('saveAIConfigService', () => {
    const mockToken = 'mock-auth-token';
    const mockRequest: SaveAIConfigPreferencesRequest = {
        aiConfigPreferences: {
            preferredModels: [
                { aiVendor: AIVendor.OPENAI, model: 'gpt-4' }
            ],
            preferredGenerativeMode: 'FACTUAL'
        },
        otherPreferences: {
            theme: 'dark'
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('saveAIConfigPreferences calls POST with correct data', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
        });

        // Act
        await saveAIConfigPreferences(mockToken, mockRequest);

        // Assert
        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.saveAIConfig, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
            body: JSON.stringify(mockRequest),
        });
    });

    test('saveAIConfigPreferences throws error on failure', async () => {
        // Arrange — no JSON body available, fall back to the status line.
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 400,
            statusText: 'Bad Request'
        });

        // Act & Assert
        await expect(saveAIConfigPreferences(mockToken, mockRequest))
            .rejects.toThrow('Failed to save AI config preferences: Bad Request');
    });

    test('saveAIConfigPreferences surfaces the server error body', async () => {
        // Arrange — a 400 whose JSON body carries the validation message
        // (e.g. an unsupported embedding model rejected at save time).
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: jest.fn().mockResolvedValue({
                error: "Unsupported embedding model(s): embeddingModelConversations='voyage-multimodal-3.5'."
            })
        });

        // Act & Assert
        await expect(saveAIConfigPreferences(mockToken, mockRequest))
            .rejects.toThrow("Unsupported embedding model(s): embeddingModelConversations='voyage-multimodal-3.5'.");
    });
});
