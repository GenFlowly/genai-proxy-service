import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmbeddingKeysSettings } from './EmbeddingKeysSettings';
import { useAuth } from '../../../context/AuthContext';
import {
    deleteEmbeddingKey,
    getEmbeddingKeys,
    storeEmbeddingKey,
    EmbeddingVendor,
} from '../../../services/embeddingKeysService';
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService';
import { AIVendor } from '../../../constants/vendors';
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models';

jest.mock('../../../context/AuthContext');
jest.mock('../../../services/embeddingKeysService', () => ({
    ...jest.requireActual('../../../services/embeddingKeysService'),
    getEmbeddingKeys: jest.fn(),
    storeEmbeddingKey: jest.fn(),
    deleteEmbeddingKey: jest.fn(),
}));
jest.mock('../../../services/storeCustomerVendorApiKeysService');

const mockUseAuth = useAuth as jest.Mock;
const mockGetEmbeddingKeys = getEmbeddingKeys as jest.Mock;
const mockStoreEmbeddingKey = storeEmbeddingKey as jest.Mock;
const mockDeleteEmbeddingKey = deleteEmbeddingKey as jest.Mock;
const mockStoreCustomerVendorApiKey = storeCustomerVendorApiKey as jest.Mock;

describe('EmbeddingKeysSettings', () => {
    const mockUpdateVendorApiKeyStatus = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();

    const authValue = (overrides: object = {}) => ({
        customerId: 'cust-123',
        isAuthenticated: true,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
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
        mockUseAuth.mockReturnValue(authValue());
    });

    test('renders OpenAI and Voyage rows, both unset by default', async () => {
        render(<EmbeddingKeysSettings />);

        expect(screen.getByText('Embedding Model API Keys')).toBeInTheDocument();
        await waitFor(() => expect(mockGetEmbeddingKeys).toHaveBeenCalled());
        expect(screen.getByTestId('embedding-keys-OPENAI-status-pill')).toHaveTextContent('Not set');
        expect(screen.getByTestId('embedding-keys-VOYAGE-status-pill')).toHaveTextContent('Not set');
    });

    test('OpenAI shows as set when the backend reports the shared key as usable', async () => {
        mockGetEmbeddingKeys.mockResolvedValue({
            statuses: [
                { vendor: EmbeddingVendor.OPENAI, isAPIKeyValid: true, status: APIKeyStatus.VALID },
                { vendor: EmbeddingVendor.VOYAGE, isAPIKeyValid: false, status: APIKeyStatus.NOT_SET },
            ],
        });

        render(<EmbeddingKeysSettings />);

        await waitFor(() =>
            expect(screen.getByTestId('embedding-keys-OPENAI-status-pill')).toHaveTextContent('Key set')
        );
        expect(screen.getByTestId('embedding-keys-VOYAGE-status-pill')).toHaveTextContent('Not set');
    });

    test('a stored key that cannot embed shows Not set with the backend detail', async () => {
        mockGetEmbeddingKeys.mockResolvedValue({
            statuses: [
                {
                    vendor: EmbeddingVendor.OPENAI,
                    isAPIKeyValid: false,
                    status: APIKeyStatus.INVALID,
                    detail: 'This key cannot access embedding models — update its permissions, or save a key that can.',
                },
                { vendor: EmbeddingVendor.VOYAGE, isAPIKeyValid: false, status: APIKeyStatus.NOT_SET },
            ],
        });

        render(<EmbeddingKeysSettings />);

        await waitFor(() =>
            expect(screen.getByTestId('embedding-key-problem-OPENAI')).toHaveTextContent(
                'OpenAI: This key cannot access embedding models'
            )
        );
        expect(screen.getByTestId('embedding-keys-OPENAI-status-pill')).toHaveTextContent('Not set');
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
        // The pill reflects the save optimistically (capability lands async)
        expect(screen.getByTestId('embedding-keys-OPENAI-status-pill')).toHaveTextContent('Key set');
        expect(mockStoreEmbeddingKey).not.toHaveBeenCalled();
    });

    test('renders the optional Hugging Face token row, unset by default', async () => {
        render(<EmbeddingKeysSettings />);

        await waitFor(() => expect(mockGetEmbeddingKeys).toHaveBeenCalled());
        expect(screen.getByTestId('hf-token-HUGGINGFACE-status-pill')).toHaveTextContent('Not set');
        // Unset token -> nothing to remove
        expect(screen.queryByTestId('hf-token-HUGGINGFACE-remove-key')).not.toBeInTheDocument();
    });

    test('saves the Hugging Face token through the embedding endpoint and flips the status', async () => {
        mockStoreEmbeddingKey.mockResolvedValue({
            keyStatus: {
                vendor: EmbeddingVendor.HUGGINGFACE,
                isAPIKeyValid: true,
                status: APIKeyStatus.VALID,
                updateSuccessful: true,
            },
        });

        render(<EmbeddingKeysSettings />);
        await userEvent.type(screen.getByTestId('hf-token-HUGGINGFACE-key-input'), 'hf_test');
        await userEvent.click(screen.getByTestId('hf-token-HUGGINGFACE-save-key'));

        await waitFor(() => {
            expect(mockStoreEmbeddingKey).toHaveBeenCalledWith('test-token', EmbeddingVendor.HUGGINGFACE, 'hf_test');
            expect(screen.getByTestId('hf-token-HUGGINGFACE-status-pill')).toHaveTextContent('Key set');
        });
        expect(mockStoreCustomerVendorApiKey).not.toHaveBeenCalled();
    });

    test('removes a stored Hugging Face token and resets the status', async () => {
        mockGetEmbeddingKeys.mockResolvedValue({
            statuses: [
                { vendor: EmbeddingVendor.OPENAI, isAPIKeyValid: false, status: APIKeyStatus.NOT_SET },
                { vendor: EmbeddingVendor.VOYAGE, isAPIKeyValid: false, status: APIKeyStatus.NOT_SET },
                { vendor: EmbeddingVendor.HUGGINGFACE, isAPIKeyValid: true, status: APIKeyStatus.VALID },
            ],
        });
        mockDeleteEmbeddingKey.mockResolvedValue(undefined);

        render(<EmbeddingKeysSettings />);
        await waitFor(() =>
            expect(screen.getByTestId('hf-token-HUGGINGFACE-status-pill')).toHaveTextContent('Key set')
        );
        await userEvent.click(screen.getByTestId('hf-token-HUGGINGFACE-remove-key'));

        await waitFor(() => {
            expect(mockDeleteEmbeddingKey).toHaveBeenCalledWith('test-token', EmbeddingVendor.HUGGINGFACE);
            expect(screen.getByTestId('hf-token-HUGGINGFACE-status-pill')).toHaveTextContent('Not set');
        });
    });

    test('the OpenAI and Voyage rows have no remove button', async () => {
        mockGetEmbeddingKeys.mockResolvedValue({
            statuses: [
                { vendor: EmbeddingVendor.OPENAI, isAPIKeyValid: true, status: APIKeyStatus.VALID },
                { vendor: EmbeddingVendor.VOYAGE, isAPIKeyValid: true, status: APIKeyStatus.VALID },
            ],
        });

        render(<EmbeddingKeysSettings />);
        await waitFor(() =>
            expect(screen.getByTestId('embedding-keys-VOYAGE-status-pill')).toHaveTextContent('Key set')
        );
        expect(screen.queryByTestId('embedding-keys-OPENAI-remove-key')).not.toBeInTheDocument();
        expect(screen.queryByTestId('embedding-keys-VOYAGE-remove-key')).not.toBeInTheDocument();
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
});
