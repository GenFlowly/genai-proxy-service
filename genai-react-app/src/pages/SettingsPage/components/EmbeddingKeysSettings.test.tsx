import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmbeddingKeysSettings } from './EmbeddingKeysSettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import {
    getEmbeddingKeys,
    getEmbeddingModels,
    storeEmbeddingKey,
    EmbeddingVendor,
} from '../../../services/embeddingKeysService';
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService';
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService';
import { AIVendor } from '../../../constants/vendors';
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/embeddingKeysService', () => ({
    ...jest.requireActual('../../../services/embeddingKeysService'),
    getEmbeddingKeys: jest.fn(),
    getEmbeddingModels: jest.fn(),
    storeEmbeddingKey: jest.fn(),
}));
jest.mock('../../../services/storeCustomerVendorApiKeysService');
jest.mock('../../../services/saveAIConfigService');

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockGetEmbeddingKeys = getEmbeddingKeys as jest.Mock;
const mockGetEmbeddingModels = getEmbeddingModels as jest.Mock;
const mockStoreEmbeddingKey = storeEmbeddingKey as jest.Mock;
const mockStoreCustomerVendorApiKey = storeCustomerVendorApiKey as jest.Mock;
const mockSavePreferences = saveAIConfigPreferences as jest.Mock;

describe('EmbeddingKeysSettings', () => {
    const mockUpdateVendorApiKeyStatus = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();
    const mockShowToast = jest.fn();

    const authValue = (overrides: object = {}) => ({
        customerId: 'cust-123',
        isAuthenticated: true,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
        aiVendorAPIKeyStatusList: [],
        aiConfigPreferences: null,
        ...overrides,
    });

    const validOpenAIStatus = {
        aiVendor: AIVendor.OPENAI,
        status: APIKeyStatus.VALID,
        isAPIKeyValid: true,
        updateSuccessful: true,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetAccessTokenSilently.mockResolvedValue('test-token');
        mockGetEmbeddingKeys.mockResolvedValue({
            statuses: [
                { vendor: EmbeddingVendor.OPENAI, isAPIKeyValid: false, status: APIKeyStatus.NOT_SET },
                { vendor: EmbeddingVendor.VOYAGE, isAPIKeyValid: false, status: APIKeyStatus.NOT_SET },
            ],
        });
        mockGetEmbeddingModels.mockResolvedValue({ vendorModels: [] });
        mockUseAuth.mockReturnValue(authValue());
        mockUseToast.mockReturnValue({ showToast: mockShowToast });
    });

    test('renders OpenAI and Voyage rows, both unset by default', async () => {
        render(<EmbeddingKeysSettings />);

        expect(screen.getByText('Embedding Model API Keys')).toBeInTheDocument();
        await waitFor(() => expect(mockGetEmbeddingKeys).toHaveBeenCalled());
        expect(screen.getByTestId('embedding-keys-OPENAI-status-pill')).toHaveTextContent('Not set');
        expect(screen.getByTestId('embedding-keys-VOYAGE-status-pill')).toHaveTextContent('Not set');
    });

    test('OpenAI shows as set when the vendor page already stored a key', async () => {
        mockUseAuth.mockReturnValue(authValue({ aiVendorAPIKeyStatusList: [validOpenAIStatus] }));

        render(<EmbeddingKeysSettings />);

        expect(screen.getByTestId('embedding-keys-OPENAI-status-pill')).toHaveTextContent('Key set');
        expect(screen.getByTestId('embedding-keys-VOYAGE-status-pill')).toHaveTextContent('Not set');
    });

    test('Voyage shows as set from the embedding-keys endpoint', async () => {
        mockGetEmbeddingKeys.mockResolvedValue({
            statuses: [
                { vendor: EmbeddingVendor.OPENAI, isAPIKeyValid: false, status: APIKeyStatus.NOT_SET },
                { vendor: EmbeddingVendor.VOYAGE, isAPIKeyValid: true, status: APIKeyStatus.VALID },
            ],
        });

        render(<EmbeddingKeysSettings />);

        await waitFor(() =>
            expect(screen.getByTestId('embedding-keys-VOYAGE-status-pill')).toHaveTextContent('Key set')
        );
    });

    test('saves a Voyage key through the embedding endpoint and flips the status', async () => {
        mockStoreEmbeddingKey.mockResolvedValue({
            keyStatus: {
                vendor: EmbeddingVendor.VOYAGE,
                isAPIKeyValid: true,
                status: APIKeyStatus.VALID,
                updateSuccessful: true,
            },
        });

        render(<EmbeddingKeysSettings />);
        await userEvent.type(screen.getByTestId('embedding-keys-VOYAGE-key-input'), 'pa-test');
        await userEvent.click(screen.getByTestId('embedding-keys-VOYAGE-save-key'));

        await waitFor(() => {
            expect(mockStoreEmbeddingKey).toHaveBeenCalledWith('test-token', EmbeddingVendor.VOYAGE, 'pa-test');
            expect(screen.getByTestId('embedding-keys-VOYAGE-status-pill')).toHaveTextContent('Key set');
        });
        expect(mockStoreCustomerVendorApiKey).not.toHaveBeenCalled();
    });

    test('saves the OpenAI key through the shared vendor endpoint and updates the auth context', async () => {
        mockStoreCustomerVendorApiKey.mockResolvedValue({ apiKeyStatus: validOpenAIStatus });

        render(<EmbeddingKeysSettings />);
        await userEvent.type(screen.getByTestId('embedding-keys-OPENAI-key-input'), 'sk-test');
        await userEvent.click(screen.getByTestId('embedding-keys-OPENAI-save-key'));

        await waitFor(() => {
            expect(mockStoreCustomerVendorApiKey).toHaveBeenCalledWith('test-token', {
                aiVendor: EmbeddingVendor.OPENAI,
                apiKey: 'sk-test',
            });
            expect(mockUpdateVendorApiKeyStatus).toHaveBeenCalledWith(validOpenAIStatus);
        });
        expect(mockStoreEmbeddingKey).not.toHaveBeenCalled();
    });

    test('rejected Voyage key keeps the status unset', async () => {
        mockStoreEmbeddingKey.mockResolvedValue({
            keyStatus: {
                vendor: EmbeddingVendor.VOYAGE,
                isAPIKeyValid: false,
                status: APIKeyStatus.INVALID,
                updateSuccessful: false,
            },
        });

        render(<EmbeddingKeysSettings />);
        await userEvent.type(screen.getByTestId('embedding-keys-VOYAGE-key-input'), 'bad-key');
        await userEvent.click(screen.getByTestId('embedding-keys-VOYAGE-save-key'));

        await waitFor(() => {
            expect(screen.getByTestId('embedding-keys-VOYAGE-message'))
                .toHaveTextContent(APIKeyStatus.INVALID);
        });
        expect(screen.getByTestId('embedding-keys-VOYAGE-status-pill')).toHaveTextContent('Not set');
    });

    test('vendor pick filters the model dropdown and saves per-category defaults', async () => {
        mockGetEmbeddingModels.mockResolvedValue({
            vendorModels: [
                { vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4', 'voyage-4-large'] },
                { vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] },
            ],
        });
        mockSavePreferences.mockResolvedValue(undefined);

        render(<EmbeddingKeysSettings />);
        await waitFor(() => expect(mockGetEmbeddingModels).toHaveBeenCalledWith('test-token'));

        // Conversations: Voyage → voyage-4-large
        await userEvent.selectOptions(
            screen.getByTestId('embedding-vendor-select-conversations'), EmbeddingVendor.VOYAGE);
        const conversationsModels = screen.getByTestId('embedding-model-select-conversations');
        expect(conversationsModels).not.toHaveTextContent('text-embedding-3-large');
        await userEvent.selectOptions(conversationsModels, 'voyage-4-large');

        // Notes: OpenAI → text-embedding-3-large
        await userEvent.selectOptions(
            screen.getByTestId('embedding-vendor-select-notes'), EmbeddingVendor.OPENAI);
        await userEvent.selectOptions(
            screen.getByTestId('embedding-model-select-notes'), 'text-embedding-3-large');

        await userEvent.click(screen.getByTestId('save-default-embedding-model'));

        await waitFor(() => {
            expect(mockSavePreferences).toHaveBeenCalledWith('test-token', {
                aiConfigPreferences: {
                    embeddingModelConversations: 'voyage-4-large',
                    embeddingModelNotes: 'text-embedding-3-large',
                },
            });
        });
        expect(mockShowToast).toHaveBeenCalledWith('Default embedding model saved');
    });

    test('changing the vendor clears the previously selected model', async () => {
        mockGetEmbeddingModels.mockResolvedValue({
            vendorModels: [
                { vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4'] },
                { vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] },
            ],
        });

        render(<EmbeddingKeysSettings />);
        await waitFor(() => expect(mockGetEmbeddingModels).toHaveBeenCalled());

        await userEvent.selectOptions(
            screen.getByTestId('embedding-vendor-select-notes'), EmbeddingVendor.VOYAGE);
        await userEvent.selectOptions(screen.getByTestId('embedding-model-select-notes'), 'voyage-4');
        await userEvent.selectOptions(
            screen.getByTestId('embedding-vendor-select-notes'), EmbeddingVendor.OPENAI);

        expect(screen.getByTestId('embedding-model-select-notes')).toHaveValue('');
    });

    test('prefills both categories from saved preferences with legacy fallback', async () => {
        mockUseAuth.mockReturnValue(authValue({
            aiConfigPreferences: {
                embeddingModel: 'voyage-4',
                embeddingModelNotes: 'text-embedding-3-large',
            },
        }));
        mockGetEmbeddingModels.mockResolvedValue({
            vendorModels: [
                { vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4'] },
                { vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] },
            ],
        });

        render(<EmbeddingKeysSettings />);

        await waitFor(() => {
            // conversations falls back to the legacy single preference
            expect(screen.getByTestId('embedding-vendor-select-conversations')).toHaveValue(EmbeddingVendor.VOYAGE);
            expect(screen.getByTestId('embedding-model-select-conversations')).toHaveValue('voyage-4');
            expect(screen.getByTestId('embedding-vendor-select-notes')).toHaveValue(EmbeddingVendor.OPENAI);
            expect(screen.getByTestId('embedding-model-select-notes')).toHaveValue('text-embedding-3-large');
        });
    });

    test('shows the no-models hint when no provider has a key', async () => {
        render(<EmbeddingKeysSettings />);

        await waitFor(() => expect(mockGetEmbeddingModels).toHaveBeenCalled());
        expect(screen.getByText('Save an embedding API key above to choose a model.')).toBeInTheDocument();
    });

    test('refreshes the model list after a Voyage key is stored', async () => {
        mockStoreEmbeddingKey.mockResolvedValue({
            keyStatus: {
                vendor: EmbeddingVendor.VOYAGE,
                isAPIKeyValid: true,
                status: APIKeyStatus.VALID,
                updateSuccessful: true,
            },
        });

        render(<EmbeddingKeysSettings />);
        await waitFor(() => expect(mockGetEmbeddingModels).toHaveBeenCalledTimes(1));

        await userEvent.type(screen.getByTestId('embedding-keys-VOYAGE-key-input'), 'pa-test');
        await userEvent.click(screen.getByTestId('embedding-keys-VOYAGE-save-key'));

        await waitFor(() => expect(mockGetEmbeddingModels).toHaveBeenCalledTimes(2));
    });
});
