import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPage from '../../pages/SettingsPage';
import { AIVendor } from '../../constants/vendors';
import { storeCustomerVendorApiKey } from '../../services/storeCustomerVendorApiKeysService';

// Mocks
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('../../components/common/BrandName/BrandName', () => ({
    OpenAIBrandName: () => <div data-testid="brand-openai">OpenAI</div>,
    ClaudeBrandName: () => <div data-testid="brand-claude">Claude</div>,
    GeminiBrandName: () => <div data-testid="brand-gemini">Gemini</div>
}));
jest.mock('../../components/common/VendorAPIKeyStatus/VendorAPIKeyStatus', () => ({
    VendorAPIKeyStatus: () => <div data-testid="vendor-status">Status</div>
}));
jest.mock('../../services/storeCustomerVendorApiKeysService');

const mockUpdateVendorApiKeyStatus = jest.fn();
const mockGetAccessTokenSilently = jest.fn();
const mockShowToast = jest.fn();

jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        customerId: '123',
        isAuthenticated: true,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
        aiVendorAPIKeyStatusList: []
    })
}));

jest.mock('../../context/ToastContext', () => ({
    useToast: () => ({
        showToast: mockShowToast
    })
}));

describe('SettingsPage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetAccessTokenSilently.mockResolvedValue('token');
    });

    test('renders correctly', () => {
        render(<SettingsPage />);
        expect(screen.getByTestId('navbar')).toBeInTheDocument();
        expect(screen.getByText('AI Vendor API Keys')).toBeInTheDocument();
        // Check for mocked brand
        expect(screen.getByTestId('brand-openai')).toBeInTheDocument();
        expect(screen.getAllByTestId('vendor-status')).toHaveLength(3); // 3 vendors
    });

    test('validates inputs before save', async () => {
        render(<SettingsPage />);

        const inputs = screen.getAllByPlaceholderText('sk-...');
        const buttons = screen.getAllByText('Save');

        // Try saving empty
        fireEvent.click(buttons[0]); // OpenAI
        expect(mockShowToast).toHaveBeenCalledWith('Please enter a valid API key.');
        expect(storeCustomerVendorApiKey).not.toHaveBeenCalled();
    });

    test('saves valid API key successfully', async () => {
        (storeCustomerVendorApiKey as jest.Mock).mockResolvedValue({
            apiKeyStatus: { updateSuccessful: true, status: 'Success', aiVendor: AIVendor.OPENAI }
        });

        render(<SettingsPage />);

        const inputs = screen.getAllByPlaceholderText('sk-...');
        const buttons = screen.getAllByText('Save');

        // Type key
        fireEvent.change(inputs[0], { target: { value: 'sk-test' } });

        // Save
        fireEvent.click(buttons[0]);

        await waitFor(() => {
            expect(storeCustomerVendorApiKey).toHaveBeenCalledWith('token', {
                aiVendor: AIVendor.OPENAI,
                apiKey: 'sk-test'
            });
            expect(mockUpdateVendorApiKeyStatus).toHaveBeenCalled();
            expect(mockShowToast).toHaveBeenCalledWith('Success');
        });

        // Verify input cleared
        expect(inputs[0]).toHaveValue('');
    });

    test('handles save error', async () => {
        (storeCustomerVendorApiKey as jest.Mock).mockRejectedValue(new Error('API Fail'));

        render(<SettingsPage />);
        const inputs = screen.getAllByPlaceholderText('sk-...');
        const buttons = screen.getAllByText('Save');

        fireEvent.change(inputs[0], { target: { value: 'sk-test' } });
        fireEvent.click(buttons[0]);

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('API Fail');
        });
    });
});
