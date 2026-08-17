import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfigureAIVendorSettingsWidget from '../../../../components/widgets/ConfigureAIVendorSettingsWidget/ConfigureAIVendorSettingsWidget';
import { AIVendor } from '../../../../constants/vendors';
import { storeCustomerVendorApiKey } from '../../../../services/storeCustomerVendorApiKeysService';
import { useAuth } from '../../../../context/AuthContext';
import { useToast } from '../../../../context/ToastContext';

// Mocks
jest.mock('../../../../services/storeCustomerVendorApiKeysService');
jest.mock('../../../../context/AuthContext');
jest.mock('../../../../context/ToastContext');

jest.mock('../../../../components/common/BrandName/BrandName', () => ({
    OpenAIBrandName: () => <div data-testid="brand-openai">OpenAI</div>,
    ClaudeBrandName: () => <div data-testid="brand-claude">Claude</div>,
    GeminiBrandName: () => <div data-testid="brand-gemini">Gemini</div>
}));

jest.mock('../../../../components/common/VendorAPIKeyStatus/VendorAPIKeyStatus', () => ({
    VendorAPIKeyStatus: ({ vendor }: any) => <div data-testid={`vendor-status-${vendor}`}>Status</div>
}));

describe('ConfigureAIVendorSettingsWidget', () => {
    const mockUpdateVendorApiKeyStatus = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();
    const mockShowToast = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        (useAuth as jest.Mock).mockReturnValue({
            customerId: '123',
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus
        });
        (useToast as jest.Mock).mockReturnValue({
            showToast: mockShowToast
        });
        mockGetAccessTokenSilently.mockResolvedValue('token');
    });

    test('renders correctly', () => {
        render(<ConfigureAIVendorSettingsWidget />);
        expect(screen.getByText('AI Vendor API Keys')).toBeInTheDocument();
        expect(screen.getByTestId('brand-openai')).toBeInTheDocument();
        expect(screen.getByTestId('brand-claude')).toBeInTheDocument();
        expect(screen.getByTestId('brand-gemini')).toBeInTheDocument();
    });

    test('validates login status before save', async () => {
        (useAuth as jest.Mock).mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus
        });

        render(<ConfigureAIVendorSettingsWidget />);
        const buttons = screen.getAllByText('Save');
        fireEvent.click(buttons[0]);

        expect(mockShowToast).toHaveBeenCalledWith('Please log in first.');
        expect(storeCustomerVendorApiKey).not.toHaveBeenCalled();
    });

    test('validates empty API key', async () => {
        render(<ConfigureAIVendorSettingsWidget />);
        const buttons = screen.getAllByText('Save');
        fireEvent.click(buttons[0]);

        expect(mockShowToast).toHaveBeenCalledWith('Please enter a valid API key.');
        expect(storeCustomerVendorApiKey).not.toHaveBeenCalled();
    });

    test('saves valid API key successfully', async () => {
        (storeCustomerVendorApiKey as jest.Mock).mockResolvedValue({
            apiKeyStatus: { updateSuccessful: true, status: 'Success', aiVendor: AIVendor.OPENAI }
        });

        render(<ConfigureAIVendorSettingsWidget />);
        const inputs = screen.getAllByPlaceholderText('sk-...');
        const buttons = screen.getAllByText('Save');

        fireEvent.change(inputs[0], { target: { value: 'sk-test' } });
        fireEvent.click(buttons[0]);

        await waitFor(() => {
            expect(storeCustomerVendorApiKey).toHaveBeenCalledWith('token', {
                aiVendor: AIVendor.OPENAI,
                apiKey: 'sk-test'
            });
            expect(mockUpdateVendorApiKeyStatus).toHaveBeenCalled();
            expect(mockShowToast).toHaveBeenCalledWith('Success');
        });

        // Input should be cleared on success
        expect(inputs[0]).toHaveValue('');
    });

    test('handles save error gracefully', async () => {
        (storeCustomerVendorApiKey as jest.Mock).mockRejectedValue(new Error('Network Error'));

        render(<ConfigureAIVendorSettingsWidget />);
        const inputs = screen.getAllByPlaceholderText('sk-...');
        const buttons = screen.getAllByText('Save');

        fireEvent.change(inputs[0], { target: { value: 'sk-test' } });
        fireEvent.click(buttons[0]);

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('Network Error');
        });
    });
});
