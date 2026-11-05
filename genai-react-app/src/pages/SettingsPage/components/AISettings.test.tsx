import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AISettings } from './AISettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { storeCustomerVendorApiKey, storeCustomerVendorConfig } from '../../../services/storeCustomerVendorApiKeysService';
import { getTextGenerationModels } from '../../../services/getTextGenerationModelsService';
import { fetchProviderCatalog } from '../../../services/providerCatalogService';
import { withQueryClient } from '../../../test/utils/queryWrapper';
import { AIVendor } from '../../../constants/vendors';
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models';

// Mock contexts and services
jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/storeCustomerVendorApiKeysService');
jest.mock('../../../services/getTextGenerationModelsService');
jest.mock('../../../services/providerCatalogService', () => ({
    ...jest.requireActual('../../../services/providerCatalogService'),
    fetchProviderCatalog: jest.fn(),
    getCachedProviderCatalog: jest.fn(() => null),
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockStoreCustomerVendorApiKey = storeCustomerVendorApiKey as jest.Mock;
const mockStoreCustomerVendorConfig = storeCustomerVendorConfig as jest.Mock;
const mockGetTextGenerationModels = getTextGenerationModels as jest.Mock;
const mockGetProviderCatalog = fetchProviderCatalog as jest.Mock;

describe('AISettings', () => {
    const mockUpdateVendorApiKeyStatus = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();
    const mockUpdateAiConfigPreferences = jest.fn();

    const authValue = (overrides: object = {}) => ({
        customerId: 'cust-123',
        isAuthenticated: true,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
        aiVendorAPIKeyStatusList: [],
        aiConfigPreferences: null,
        updateAiConfigPreferences: mockUpdateAiConfigPreferences,
        ...overrides,
    });

    const validOpenAIStatus = {
        aiVendor: AIVendor.OPENAI,
        status: APIKeyStatus.VALID,
        isAPIKeyValid: true,
        updateSuccessful: true,
        selectedModel: 'gpt-5-mini',
        priority: 1,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        mockGetAccessTokenSilently.mockResolvedValue('test-token');
        mockUseToast.mockReturnValue({ showToast: jest.fn() });
        mockGetTextGenerationModels.mockResolvedValue({
            aiVendorModelList: [
                { aiVendor: AIVendor.OPENAI, modelsList: ['gpt-5', 'gpt-5-mini'] },
                { aiVendor: AIVendor.CLAUDE, modelsList: ['claude-fable-5'] },
                { aiVendor: AIVendor.GEMINI, modelsList: [] },
            ],
        });
        mockGetProviderCatalog.mockResolvedValue({
            providers: [
                { id: 'openai', displayName: 'OpenAI', native: true, models: [{ name: 'gpt-5', supportsTools: true }] },
                { id: 'anthropic', displayName: 'Claude', native: true, models: [{ name: 'claude-fable-5', supportsTools: true }] },
                { id: 'gemini', displayName: 'Gemini', native: true, models: [{ name: 'gemini-2.5-pro', supportsTools: true }] },
                { id: 'groq', displayName: 'Groq', native: true, models: [{ name: 'llama-3.3-70b-versatile', supportsTools: true }] },
                { id: 'openrouter', displayName: 'OpenRouter', native: false, models: [{ name: 'meta-llama/llama-3-70b', supportsTools: false }] },
            ],
        });
        mockUseAuth.mockReturnValue(authValue());
    });

    test('says the priority 1 provider also runs titles and learned facts', () => {
        render(withQueryClient(<AISettings />));

        expect(screen.getByTestId('ai-settings-primary-note')).toHaveTextContent(
            'Your priority 1 provider also writes chat and note titles and learns facts about you'
        );
    });

    test('hides vendors without keys behind the add-vendor dropdown', async () => {
        render(withQueryClient(<AISettings />));

        // No keys set → no cards, every supported vendor is offered in the dropdown
        (Object.values(AIVendor) as AIVendor[]).forEach(vendor => {
            expect(screen.queryByTestId(`ai-settings-vendors-${vendor}-status-pill`)).not.toBeInTheDocument();
        });
        const dropdown = screen.getByTestId('add-vendor-select');
        expect(dropdown).toBeInTheDocument();

        // Picking a vendor reveals its card (still keyless → "Not set")
        await userEvent.selectOptions(dropdown, AIVendor.CLAUDE);
        expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.CLAUDE}-status-pill`)).toHaveTextContent('Not set');
        expect(screen.queryByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-status-pill`)).not.toBeInTheDocument();
    });

    test('vendors with a saved key show as cards and leave the dropdown', async () => {
        mockUseAuth.mockReturnValue(authValue({ aiVendorAPIKeyStatusList: [validOpenAIStatus] }));

        render(withQueryClient(<AISettings />));

        expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-status-pill`)).toHaveTextContent('Key set');
        const dropdown = screen.getByTestId('add-vendor-select');
        await waitFor(() => expect(dropdown).toHaveTextContent('Claude'));
        expect(dropdown).not.toHaveTextContent('OpenAI');
        expect(dropdown).toHaveTextContent('Gemini');
        // Long-tail catalog vendors are addable too
        expect(dropdown).toHaveTextContent('Groq');
        expect(dropdown).toHaveTextContent('OpenRouter');
    });

    test('a long-tail catalog vendor can be added and lists its catalog models', async () => {
        render(withQueryClient(<AISettings />));

        const dropdown = screen.getByTestId('add-vendor-select');
        await waitFor(() => expect(dropdown).toHaveTextContent('Groq'));
        await userEvent.selectOptions(dropdown, 'groq');

        // Card appears with a plain-text label and the catalog's model list
        expect(screen.getByTestId('ai-settings-vendors-groq-status-pill')).toHaveTextContent('Not set');
        expect(screen.getByText('Groq')).toBeInTheDocument();
    });

    test('a keyed vendor whose live list is still empty offers its catalog models', async () => {
        mockUseAuth.mockReturnValue(authValue({
            aiVendorAPIKeyStatusList: [{ ...validOpenAIStatus, aiVendor: AIVendor.GEMINI }],
        }));

        render(withQueryClient(<AISettings />));

        await waitFor(() =>
            expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.GEMINI}-model`)).toHaveTextContent('gemini-2.5-pro')
        );
    });

    test('shows model/priority config only for vendors with a valid key', () => {
        mockUseAuth.mockReturnValue(authValue({ aiVendorAPIKeyStatusList: [validOpenAIStatus] }));

        render(withQueryClient(<AISettings />));

        expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-status-pill`)).toHaveTextContent('Key set');
        expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-config`)).toBeInTheDocument();
        expect(screen.queryByTestId(`ai-settings-vendors-${AIVendor.CLAUDE}-config`)).not.toBeInTheDocument();
        expect(screen.queryByTestId(`ai-settings-vendors-${AIVendor.GEMINI}-config`)).not.toBeInTheDocument();
        // No delete endpoint for customers — remove button must not render
        expect(screen.queryByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-remove-key`)).not.toBeInTheDocument();
    });

    test('saves an API key and updates the auth context', async () => {
        mockStoreCustomerVendorApiKey.mockResolvedValue({
            apiKeyStatus: {
                aiVendor: AIVendor.OPENAI,
                updateSuccessful: true,
                status: APIKeyStatus.VALID,
                isAPIKeyValid: true,
            },
        });

        render(withQueryClient(<AISettings />));
        await userEvent.selectOptions(screen.getByTestId('add-vendor-select'), AIVendor.OPENAI);
        await userEvent.type(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-key-input`), 'test-key');
        await userEvent.click(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-save-key`));

        await waitFor(() => {
            expect(mockStoreCustomerVendorApiKey).toHaveBeenCalledWith('test-token', {
                aiVendor: AIVendor.OPENAI,
                apiKey: 'test-key',
            });
            expect(mockUpdateVendorApiKeyStatus).toHaveBeenCalledWith(
                expect.objectContaining({ aiVendor: AIVendor.OPENAI, updateSuccessful: true })
            );
            expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-message`))
                .toHaveTextContent(APIKeyStatus.VALID);
        });
    });

    test('shows the rejection message when the vendor rejects the key', async () => {
        mockStoreCustomerVendorApiKey.mockResolvedValue({
            apiKeyStatus: {
                aiVendor: AIVendor.OPENAI,
                updateSuccessful: false,
                status: APIKeyStatus.INVALID,
                isAPIKeyValid: false,
            },
        });

        render(withQueryClient(<AISettings />));
        await userEvent.selectOptions(screen.getByTestId('add-vendor-select'), AIVendor.OPENAI);
        await userEvent.type(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-key-input`), 'bad-key');
        await userEvent.click(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-save-key`));

        await waitFor(() => {
            expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-message`))
                .toHaveTextContent(APIKeyStatus.INVALID);
        });
        expect(mockUpdateVendorApiKeyStatus).not.toHaveBeenCalled();
    });

    test('shows a login message when saving unauthenticated', async () => {
        mockUseAuth.mockReturnValue(authValue({ customerId: null, isAuthenticated: false }));

        render(withQueryClient(<AISettings />));
        await userEvent.selectOptions(screen.getByTestId('add-vendor-select'), AIVendor.OPENAI);
        await userEvent.type(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-key-input`), 'test-key');
        await userEvent.click(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-save-key`));

        await waitFor(() => {
            expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-message`))
                .toHaveTextContent('Please log in first.');
        });
    });

    test('saves model + priority config and merges it into the auth context', async () => {
        mockStoreCustomerVendorConfig.mockResolvedValue(undefined);
        mockUseAuth.mockReturnValue(authValue({ aiVendorAPIKeyStatusList: [validOpenAIStatus] }));

        render(withQueryClient(<AISettings />));

        const saveConfig = screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-save-config`);
        // Prefilled with saved values → not dirty → disabled
        expect(saveConfig).toBeDisabled();

        // Wait for the fetched model list to populate the dropdown
        await screen.findByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-model-option-gpt-5`);
        fireEvent.change(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-model`), {
            target: { value: 'gpt-5' },
        });
        await userEvent.click(saveConfig);

        await waitFor(() => {
            expect(mockStoreCustomerVendorConfig).toHaveBeenCalledWith('test-token', {
                aiVendor: AIVendor.OPENAI,
                model: 'gpt-5',
                priority: 1,
                thinkingLevel: '',
            });
            expect(mockUpdateVendorApiKeyStatus).toHaveBeenCalledWith({
                ...validOpenAIStatus,
                selectedModel: 'gpt-5',
                priority: 1,
                thinkingLevel: null,
            });
        });
        // The preferredModels mirror is storeCustomerVendorConfig's own
        // write-through (covered in its service test) — the page must not
        // mirror it ad hoc.
        expect(mockUpdateAiConfigPreferences).not.toHaveBeenCalled();
    });

    test('reasoning effort rides the vendor-config save', async () => {
        mockUseAuth.mockReturnValue(authValue({
            aiVendorAPIKeyStatusList: [validOpenAIStatus],
        }));

        render(withQueryClient(<AISettings />));
        const saveConfig = await screen.findByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-save-config`);
        await screen.findByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-model-option-gpt-5`);
        fireEvent.change(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-model`), {
            target: { value: 'gpt-5' },
        });
        fireEvent.change(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-thinking`), {
            target: { value: 'low' },
        });
        await userEvent.click(saveConfig);

        await waitFor(() => {
            expect(mockStoreCustomerVendorConfig).toHaveBeenCalledWith('test-token', {
                aiVendor: AIVendor.OPENAI,
                model: 'gpt-5',
                priority: 1,
                thinkingLevel: 'low',
            });
        });
    });

    test('saved model prefers the shared preferredModels over the vendor config', async () => {
        mockUseAuth.mockReturnValue(authValue({
            aiVendorAPIKeyStatusList: [validOpenAIStatus],
            aiConfigPreferences: {
                preferredModels: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-5' }],
            },
        }));

        render(withQueryClient(<AISettings />));

        // validOpenAIStatus says gpt-5-mini, but preferredModels wins
        await waitFor(() => {
            expect(screen.getByTestId(`ai-settings-vendors-${AIVendor.OPENAI}-model`)).toHaveValue('gpt-5');
        });
    });
});
