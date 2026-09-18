import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AISettings } from './AISettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { storeCustomerVendorApiKey, storeCustomerVendorConfig } from '../../../services/storeCustomerVendorApiKeysService';
import { getTextGenerationModels } from '../../../services/getTextGenerationModelsService';
import { AIVendor } from '../../../constants/vendors';
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models';

// Mock contexts and services
jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/storeCustomerVendorApiKeysService');
jest.mock('../../../services/getTextGenerationModelsService');

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockStoreCustomerVendorApiKey = storeCustomerVendorApiKey as jest.Mock;
const mockStoreCustomerVendorConfig = storeCustomerVendorConfig as jest.Mock;
const mockGetTextGenerationModels = getTextGenerationModels as jest.Mock;

describe('AISettings', () => {
    const mockUpdateVendorApiKeyStatus = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();

    const authValue = (overrides: object = {}) => ({
        customerId: 'cust-123',
        isAuthenticated: true,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
        aiVendorAPIKeyStatusList: [],
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
        mockUseAuth.mockReturnValue(authValue());
    });

    test('renders a card per vendor with key status', () => {
        render(<AISettings />);

        expect(screen.getByText('Model API Keys')).toBeInTheDocument();
        (Object.values(AIVendor) as AIVendor[]).forEach(vendor => {
            expect(screen.getByTestId(`ai-settings-vendors-${vendor}-status-pill`)).toHaveTextContent('Not set');
        });
    });

    test('shows model/priority config only for vendors with a valid key', () => {
        mockUseAuth.mockReturnValue(authValue({ aiVendorAPIKeyStatusList: [validOpenAIStatus] }));

        render(<AISettings />);

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

        render(<AISettings />);
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

        render(<AISettings />);
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

        render(<AISettings />);
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

        render(<AISettings />);

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
            });
            expect(mockUpdateVendorApiKeyStatus).toHaveBeenCalledWith({
                ...validOpenAIStatus,
                selectedModel: 'gpt-5',
                priority: 1,
            });
        });
    });
});
