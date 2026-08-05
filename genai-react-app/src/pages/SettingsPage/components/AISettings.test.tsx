import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AISettings } from './AISettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService';
import { AIVendor } from '../../../constants/vendors';
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models';

// Mock contexts and services
jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/storeCustomerVendorApiKeysService');

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockStoreCustomerVendorApiKey = storeCustomerVendorApiKey as jest.Mock;

describe('AISettings', () => {
    const mockUpdateVendorApiKeyStatus = jest.fn();
    const mockShowToast = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetAccessTokenSilently.mockResolvedValue('test-token');
        mockUseToast.mockReturnValue({ showToast: mockShowToast });
        mockUseAuth.mockReturnValue({
            customerId: 'cust-123',
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
            aiVendorAPIKeyStatusList: []
        });
    });

    test('renders vendor sections', () => {
        render(<AISettings />);
        
        expect(screen.getByText('AI Models & Providers')).toBeInTheDocument();
        expect(screen.getByText('OpenAI')).toBeInTheDocument();
        expect(screen.getByText('Claude')).toBeInTheDocument();
        expect(screen.getByText('Gemini')).toBeInTheDocument();
        
        // Should have "Save" buttons for all 3 vendors
        const saveButtons = screen.getAllByText('Save');
        expect(saveButtons).toHaveLength(3);
    });

    test('shows Overwrite API Key when vendor has valid status', () => {
        mockUseAuth.mockReturnValue({
            customerId: 'cust-123',
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
            aiVendorAPIKeyStatusList: [
                {
                    aiVendor: AIVendor.OPENAI,
                    status: APIKeyStatus.VALID,
                    isAPIKeyValid: true,
                    updateSuccessful: true
                }
            ]
        });

        render(<AISettings />);
        
        // OpenAI button should say "Overwrite API Key"
        expect(screen.getByText('Overwrite API Key')).toBeInTheDocument();
        
        // Other buttons should still say "Save"
        const saveButtons = screen.getAllByText('Save');
        expect(saveButtons).toHaveLength(2);
    });

    test('updates api key value on change', async () => {
        render(<AISettings />);
        const inputs = screen.getAllByPlaceholderText('sk-...');
        const openaiInput = inputs[0];

        await userEvent.type(openaiInput, 'test-key');
        expect(openaiInput).toHaveValue('test-key');
    });

    test('shows toast if trying to save unauthenticated', async () => {
        mockUseAuth.mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
            aiVendorAPIKeyStatusList: []
        });

        render(<AISettings />);
        const saveButtons = screen.getAllByText('Save');
        await userEvent.click(saveButtons[0]);

        expect(mockShowToast).toHaveBeenCalledWith('Please log in first.');
    });

    test('shows toast if api key is empty on save', async () => {
        render(<AISettings />);
        const saveButtons = screen.getAllByText('Save');
        await userEvent.click(saveButtons[0]);

        expect(mockShowToast).toHaveBeenCalledWith('Please enter a valid API key.');
    });

    test('saves API key successfully', async () => {
        mockStoreCustomerVendorApiKey.mockResolvedValue({
            apiKeyStatus: {
                aiVendor: AIVendor.OPENAI,
                updateSuccessful: true,
                status: 'Key valid',
                isAPIKeyValid: true
            }
        });

        render(<AISettings />);
        const inputs = screen.getAllByPlaceholderText('sk-...');
        await userEvent.type(inputs[0], 'test-key');

        const saveButtons = screen.getAllByText('Save');
        await userEvent.click(saveButtons[0]);

        await waitFor(() => {
            expect(mockStoreCustomerVendorApiKey).toHaveBeenCalledWith('test-token', {
                aiVendor: AIVendor.OPENAI,
                apiKey: 'test-key'
            });
            expect(mockUpdateVendorApiKeyStatus).toHaveBeenCalledWith({
                aiVendor: AIVendor.OPENAI,
                updateSuccessful: true,
                status: 'Key valid',
                isAPIKeyValid: true
            });
            expect(mockShowToast).toHaveBeenCalledWith('Key valid');
            expect(inputs[0]).toHaveValue('');
        });
    });

    test('shows toast if api key save fails', async () => {
        mockStoreCustomerVendorApiKey.mockRejectedValue(new Error('Invalid key'));

        render(<AISettings />);
        const inputs = screen.getAllByPlaceholderText('sk-...');
        await userEvent.type(inputs[0], 'test-key');

        const saveButtons = screen.getAllByText('Save');
        await userEvent.click(saveButtons[0]);

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('Invalid key');
        });
    });
});
