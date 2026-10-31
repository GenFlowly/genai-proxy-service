import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmbeddingModelDefaults } from './EmbeddingModelDefaults';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { EmbeddingVendor, getEmbeddingModels } from '../../../services/embeddingKeysService';
import { embeddingModelsCache } from '../../../services/defaultsCacheService';
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService';
import { withQueryClient } from '../../../test/utils/queryWrapper';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
// The component reads the model catalog through useEmbeddingModels → service
jest.mock('../../../services/embeddingKeysService', () => ({
    ...jest.requireActual('../../../services/embeddingKeysService'),
    getEmbeddingModels: jest.fn(),
}));
jest.mock('../../../services/saveAIConfigService');

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockModelsFetch = getEmbeddingModels as jest.Mock;
const mockSavePreferences = saveAIConfigPreferences as jest.Mock;

describe('EmbeddingModelDefaults', () => {
    const mockGetAccessTokenSilently = jest.fn();
    const mockShowToast = jest.fn();

    const authValue = (overrides: object = {}) => ({
        customerId: `cust-${testSeq}`,
        isAuthenticated: true,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        aiConfigPreferences: null,
        ...overrides,
    });

    let testSeq = 0;
    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        testSeq += 1;
        mockGetAccessTokenSilently.mockResolvedValue('test-token');
        mockModelsFetch.mockResolvedValue({ vendorModels: [] });
        mockUseAuth.mockReturnValue(authValue());
        mockUseToast.mockReturnValue({ showToast: mockShowToast });
    });

    test('vendor pick filters the model dropdown and saves per-category defaults', async () => {
        mockModelsFetch.mockResolvedValue({
            vendorModels: [
                { vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4', 'voyage-4-large'] },
                { vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] },
            ],
        });
        mockSavePreferences.mockResolvedValue(undefined);

        render(withQueryClient(<EmbeddingModelDefaults />));
        await waitFor(() => expect(mockModelsFetch).toHaveBeenCalledWith('test-token'));

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
        mockModelsFetch.mockResolvedValue({
            vendorModels: [
                { vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4'] },
                { vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] },
            ],
        });

        render(withQueryClient(<EmbeddingModelDefaults />));
        await waitFor(() => expect(mockModelsFetch).toHaveBeenCalled());

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
        mockModelsFetch.mockResolvedValue({
            vendorModels: [
                { vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4'] },
                { vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] },
            ],
        });

        render(withQueryClient(<EmbeddingModelDefaults />));

        await waitFor(() => {
            // conversations falls back to the legacy single preference
            expect(screen.getByTestId('embedding-vendor-select-conversations')).toHaveValue(EmbeddingVendor.VOYAGE);
            expect(screen.getByTestId('embedding-model-select-conversations')).toHaveValue('voyage-4');
            expect(screen.getByTestId('embedding-vendor-select-notes')).toHaveValue(EmbeddingVendor.OPENAI);
            expect(screen.getByTestId('embedding-model-select-notes')).toHaveValue('text-embedding-3-large');
        });
    });

    test('renders the cached model list instantly while the refresh is pending', async () => {
        embeddingModelsCache.save(`cust-${testSeq}`, {
            vendorModels: [{ vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4'] }],
        } as any, null);
        mockModelsFetch.mockReturnValue(new Promise(() => undefined));

        render(withQueryClient(<EmbeddingModelDefaults />));

        await userEvent.selectOptions(
            screen.getByTestId('embedding-vendor-select-conversations'), EmbeddingVendor.VOYAGE);
        expect(screen.getByTestId('embedding-vendor-select-conversations')).toHaveValue(EmbeddingVendor.VOYAGE);
        expect(
            screen.queryByText('Save an embedding API key on the Embedding Model API Keys page to choose a model.')
        ).not.toBeInTheDocument();
    });

    test('shows the no-models hint when no provider has a key', async () => {
        render(withQueryClient(<EmbeddingModelDefaults />));

        await waitFor(() => expect(mockModelsFetch).toHaveBeenCalled());
        expect(
            screen.getByText('Save an embedding API key on the Embedding Model API Keys page to choose a model.')
        ).toBeInTheDocument();
    });

    test('shows an error toast when saving fails', async () => {
        mockModelsFetch.mockResolvedValue({
            vendorModels: [{ vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4'] }],
        });
        mockSavePreferences.mockRejectedValueOnce(new Error('save failed'));

        render(withQueryClient(<EmbeddingModelDefaults />));
        await waitFor(() => expect(mockModelsFetch).toHaveBeenCalled());

        await userEvent.selectOptions(
            screen.getByTestId('embedding-vendor-select-conversations'), EmbeddingVendor.VOYAGE);
        await userEvent.selectOptions(
            screen.getByTestId('embedding-model-select-conversations'), 'voyage-4');
        await userEvent.click(screen.getByTestId('save-default-embedding-model'));

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('save failed'));
    });
});
