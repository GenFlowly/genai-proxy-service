import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPage from '../../pages/SettingsPage';
import { AIVendor } from '../../constants/vendors';
import { storeCustomerVendorApiKey } from '../../services/storeCustomerVendorApiKeysService';
import { storeCustomerVectorDBConfig } from '../../services/storeCustomerVectorDBConfigService';

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
jest.mock('../../components/common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus', () => ({
    CustomerVectorDBConfigStatus: () => <div data-testid="vector-db-status">DBStatus</div>
}));
jest.mock('../../services/storeCustomerVendorApiKeysService');
jest.mock('../../services/storeCustomerVectorDBConfigService');

const mockUpdateVendorApiKeyStatus = jest.fn();
const mockUpdateVectorDBConfigStatus = jest.fn();
const mockGetAccessTokenSilently = jest.fn();
const mockShowToast = jest.fn();

jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        customerId: '123',
        isAuthenticated: true,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        updateVendorApiKeyStatus: mockUpdateVendorApiKeyStatus,
        updateVectorDBConfigStatus: mockUpdateVectorDBConfigStatus,
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
        expect(screen.getByText('Vector Database Settings')).toBeInTheDocument();
        expect(screen.getByTestId('vector-db-status')).toBeInTheDocument();
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

    describe('Vector Database Settings (Zilliz)', () => {
        test('validates missing endpoint and token', () => {
            render(<SettingsPage />);
            const zillizSaveButton = screen.getAllByRole('button', { name: /Save/i })[3]; // 4th button

            expect(zillizSaveButton).toBeDisabled();
        });

        test('validates incorrect endpoint format', async () => {
            render(<SettingsPage />);
            const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
            const tokenInput = screen.getByPlaceholderText('Placeholder token...');
            const buttons = screen.getAllByText('Save');

            fireEvent.change(endpointInput, { target: { value: 'invalid-url' } });
            fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

            fireEvent.click(buttons[3]);

            expect(mockShowToast).toHaveBeenCalledWith('Invalid Zilliz endpoint format.');
            expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled();
        });

        test('validates incorrect token format', async () => {
            render(<SettingsPage />);
            const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
            const tokenInput = screen.getByPlaceholderText('Placeholder token...');
            const buttons = screen.getAllByText('Save');

            fireEvent.change(endpointInput, { target: { value: 'https://in03-123.serverless.aws.cloud.zilliz.com' } });
            fireEvent.change(tokenInput, { target: { value: 'short-token' } });

            fireEvent.click(buttons[3]);

            expect(mockShowToast).toHaveBeenCalledWith('Invalid Zilliz token format. Expected a long hex string.');
            expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled();
        });

        test('saves valid Zilliz settings successfully', async () => {
            (storeCustomerVectorDBConfig as jest.Mock).mockResolvedValue({
                configStatus: { updateSuccessful: true, vendor: 'Zilliz', status: 'PRESENT' }
            });

            render(<SettingsPage />);
            const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
            const tokenInput = screen.getByPlaceholderText('Placeholder token...');
            const buttons = screen.getAllByText('Save');

            fireEvent.change(endpointInput, { target: { value: 'https://in03-123.serverless.aws.cloud.zilliz.com' } });
            fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

            fireEvent.click(buttons[3]);

            await waitFor(() => {
                expect(storeCustomerVectorDBConfig).toHaveBeenCalledWith('token', {
                    vendor: 'Zilliz',
                    endpoint: 'https://in03-123.serverless.aws.cloud.zilliz.com',
                    token: 'a'.repeat(64)
                });
                expect(mockUpdateVectorDBConfigStatus).toHaveBeenCalledWith(
                    expect.objectContaining({ updateSuccessful: true, vendor: 'Zilliz', status: 'PRESENT' })
                );
                expect(mockShowToast).toHaveBeenCalledWith('Zilliz settings saved successfully.');
            });

            expect(endpointInput).toHaveValue('');
            expect(tokenInput).toHaveValue('');
        });

        test('handles Zilliz save failure cleanly without updating context', async () => {
            (storeCustomerVectorDBConfig as jest.Mock).mockResolvedValue({
                configStatus: { updateSuccessful: false, vendor: 'Zilliz', status: 'NOT_SET' }
            });

            render(<SettingsPage />);
            const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
            const tokenInput = screen.getByPlaceholderText('Placeholder token...');
            const buttons = screen.getAllByText('Save');

            fireEvent.change(endpointInput, { target: { value: 'https://in03-123.serverless.aws.cloud.zilliz.com' } });
            fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

            fireEvent.click(buttons[3]);

            await waitFor(() => {
                expect(storeCustomerVectorDBConfig).toHaveBeenCalled();
                expect(mockUpdateVectorDBConfigStatus).not.toHaveBeenCalled();
                expect(mockShowToast).toHaveBeenCalledWith('Zilliz settings saved successfully.');
            });

            expect(endpointInput).toHaveValue('');
            expect(tokenInput).toHaveValue('');
        });

        test('catches completely rejected promise from Zilliz save', async () => {
            (storeCustomerVectorDBConfig as jest.Mock).mockRejectedValue(new Error('VectorDB API Fail'));

            render(<SettingsPage />);
            const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
            const tokenInput = screen.getByPlaceholderText('Placeholder token...');
            const buttons = screen.getAllByText('Save');

            fireEvent.change(endpointInput, { target: { value: 'https://in03-123.serverless.aws.cloud.zilliz.com' } });
            fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

            fireEvent.click(buttons[3]);

            await waitFor(() => {
                expect(mockShowToast).toHaveBeenCalledWith('VectorDB API Fail');
            });
        });
    });
});
