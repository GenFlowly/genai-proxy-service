import React from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmbeddingModelDefaults } from './EmbeddingModelDefaults';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { EmbeddingVendor, getEmbeddingModels } from '../../../services/embeddingKeysService';
import { EmbeddingModelLockedError, saveAIConfigPreferences } from '../../../services/saveAIConfigService';
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models';
import { getAiPreferences, mergeAiPreferences, replaceAiPreferences } from '../../../stores/aiPreferencesStore';
import { withQueryClient } from '../../../test/utils/queryWrapper';
import { renderSettingsPage } from '../settingsTestUtils';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/embeddingKeysService', () => ({
    ...jest.requireActual('../../../services/embeddingKeysService'),
    getEmbeddingModels: jest.fn(),
}));
jest.mock('../../../services/saveAIConfigService', () => ({
    ...jest.requireActual('../../../services/saveAIConfigService'),
    saveAIConfigPreferences: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockModelsFetch = getEmbeddingModels as jest.Mock;
const mockSave = saveAIConfigPreferences as jest.Mock;

const BOTH_VENDORS = {
    vendorModels: [
        { vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-small', 'text-embedding-3-large'] },
        { vendor: EmbeddingVendor.VOYAGE, models: ['voyage-4-large'] },
    ],
};

describe('EmbeddingModelDefaults', () => {
    const getAccessTokenSilently = jest.fn();
    const showToast = jest.fn();
    const resyncAccount = jest.fn();
    let testSeq = 0;
    const auth = (overrides: Record<string, unknown> = {}) => mockUseAuth.mockReturnValue({
        customerId: `cust-${testSeq}`,
        isAuthenticated: true,
        getAccessTokenSilently,
        resyncAccount,
        aiVendorAPIKeyStatusList: [],
        ...overrides,
    });
    const renderPage = () => renderSettingsPage(withQueryClient(<EmbeddingModelDefaults />));
    const chooseModel = async (vendor: string, model: string) => {
        await screen.findByTestId(`embedding-vendor-select-conversations-option-${vendor}`);
        await userEvent.selectOptions(screen.getByTestId('embedding-vendor-select-conversations'), vendor);
        await userEvent.selectOptions(screen.getByTestId('embedding-model-select-conversations'), model);
    };

    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        testSeq += 1;
        replaceAiPreferences(`cust-${testSeq}`, {});
        getAccessTokenSilently.mockResolvedValue('test-token');
        mockModelsFetch.mockResolvedValue(BOTH_VENDORS);
        auth();
        mockUseToast.mockReturnValue({ showToast });
        mockSave.mockImplementation(async (_token: string, payload: any) => {
            mergeAiPreferences(payload.aiConfigPreferences);
        });
    });

    test('nothing chosen: "Not chosen", the platform default in use, and lock disabled until a model is picked', async () => {
        renderPage();

        expect(screen.getAllByText('Not chosen').length).toBeGreaterThan(0);
        expect(screen.getByText('voyage-4-large in use')).toBeInTheDocument();
        expect(screen.getByTestId('save-default-embedding-model')).toBeDisabled();

        await chooseModel(EmbeddingVendor.OPENAI, 'text-embedding-3-large');
        expect(screen.getByTestId('save-default-embedding-model')).toBeEnabled();
    });

    test('changing the provider clears the picked model', async () => {
        renderPage();
        await chooseModel(EmbeddingVendor.OPENAI, 'text-embedding-3-large');

        await userEvent.selectOptions(screen.getByTestId('embedding-vendor-select-conversations'), EmbeddingVendor.VOYAGE);

        expect(screen.getByTestId('embedding-model-select-conversations')).toHaveValue('');
        expect(screen.getByTestId('save-default-embedding-model')).toBeDisabled();
    });

    test('locking needs LOCK typed, then saves the one model and shows it locked', async () => {
        renderPage();
        await chooseModel(EmbeddingVendor.OPENAI, 'text-embedding-3-large');
        await userEvent.click(screen.getByTestId('save-default-embedding-model'));

        expect(screen.getByRole('heading', { name: 'Lock text-embedding-3-large?' })).toBeInTheDocument();
        const confirm = screen.getByTestId('embedding-model-lock-dialog-confirm');
        expect(confirm).toBeDisabled();
        await userEvent.type(screen.getByTestId('embedding-model-lock-dialog-input'), 'LOCK');
        await userEvent.click(confirm);

        await waitFor(() => expect(mockSave).toHaveBeenCalledWith('test-token', {
            aiConfigPreferences: { embeddingModelConversations: 'text-embedding-3-large' },
        }));
        expect(showToast).toHaveBeenCalledWith('text-embedding-3-large is now your embedding model.');
        expect(resyncAccount).toHaveBeenCalled();
        expect(await screen.findByTestId('embedding-model-locked-model')).toHaveValue('text-embedding-3-large');
        expect(screen.queryByTestId('save-default-embedding-model')).not.toBeInTheDocument();
    });

    test('a 409 shows the model that is already locked', async () => {
        mockSave.mockRejectedValue(new EmbeddingModelLockedError('The embedding model is locked.', 'voyage-4-large'));
        renderPage();
        await chooseModel(EmbeddingVendor.OPENAI, 'text-embedding-3-large');
        await userEvent.click(screen.getByTestId('save-default-embedding-model'));
        await userEvent.type(screen.getByTestId('embedding-model-lock-dialog-input'), 'LOCK');
        await userEvent.click(screen.getByTestId('embedding-model-lock-dialog-confirm'));

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Your embedding model is already locked to voyage-4-large.'));
        expect(getAiPreferences()?.embeddingModelConversations).toBe('voyage-4-large');
        expect(await screen.findByTestId('embedding-model-locked-model')).toHaveValue('voyage-4-large');
        expect(screen.getByTestId('embedding-model-locked-vendor')).toHaveValue('Voyage AI');
    });

    test('any other failure keeps the form and shows the error', async () => {
        mockSave.mockRejectedValue(new Error('Unsupported embedding model'));
        renderPage();
        await chooseModel(EmbeddingVendor.OPENAI, 'text-embedding-3-large');
        await userEvent.click(screen.getByTestId('save-default-embedding-model'));
        await userEvent.type(screen.getByTestId('embedding-model-lock-dialog-input'), 'LOCK');
        await userEvent.click(screen.getByTestId('embedding-model-lock-dialog-confirm'));

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Unsupported embedding model'));
        expect(screen.getByTestId('save-default-embedding-model')).toBeInTheDocument();
    });

    test('a chosen model is locked and read-only, with the date it was chosen', async () => {
        act(() => {
            replaceAiPreferences(`cust-${testSeq}`, {
                embeddingModelConversations: 'text-embedding-3-small',
                embeddingModelChosenAt: '2026-11-17T09:00:00Z',
            });
        });
        renderPage();

        expect(screen.getAllByText('Locked').length).toBeGreaterThan(0);
        expect(screen.getByTestId('embedding-model-locked-model')).toHaveValue('text-embedding-3-small');
        expect(screen.getByTestId('embedding-model-locked-model')).toHaveAttribute('readonly');
        expect(screen.getByText(`Chosen ${new Date('2026-11-17T09:00:00Z').toLocaleDateString()}`)).toBeInTheDocument();
        expect(screen.queryByTestId('embedding-vendor-select-conversations')).not.toBeInTheDocument();
    });

    test('a locked model its working key no longer offers can be chosen again', async () => {
        act(() => {
            replaceAiPreferences(`cust-${testSeq}`, { embeddingModelConversations: 'voyage-multimodal-3.5' });
        });
        renderPage();

        expect(await screen.findByText("voyage-multimodal-3.5 can't be used anymore")).toBeInTheDocument();
        expect(screen.getAllByText("Can't be used").length).toBeGreaterThan(0);
        expect(screen.getByTestId('save-default-embedding-model')).toBeInTheDocument();
    });

    test('a locked model whose key cannot embed stays locked', async () => {
        mockModelsFetch.mockResolvedValue({ vendorModels: [{ vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] }] });
        act(() => {
            replaceAiPreferences(`cust-${testSeq}`, { embeddingModelConversations: 'voyage-multimodal-3.5' });
        });
        renderPage();

        await waitFor(() => expect(mockModelsFetch).toHaveBeenCalled());
        expect(screen.getByTestId('embedding-model-locked-model')).toHaveValue('voyage-multimodal-3.5');
    });

    test('own-key users see which providers are ready, with a Set up link', async () => {
        auth({ aiVendorAPIKeyStatusList: [{ aiVendor: 'OPENAI', isAPIKeyValid: true, status: APIKeyStatus.VALID }] });
        mockModelsFetch.mockResolvedValue({ vendorModels: [{ vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] }] });
        renderPage();

        const row = screen.getByTestId('embedding-model-readiness');
        expect(await within(row).findByText(/^openai · ready$/i)).toBeInTheDocument();
        expect(within(row).getByText('Voyage AI · not set up')).toBeInTheDocument();
        expect(within(row).getByRole('link', { name: 'Set up' })).toHaveAttribute('href', '/settings/byok/embedding-keys');
    });

    test('app-key users see no readiness row', () => {
        renderPage();

        expect(screen.queryByTestId('embedding-model-readiness')).not.toBeInTheDocument();
    });
});
