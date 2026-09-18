import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DatabaseConnectionsSettingsWidget from '../../../../components/widgets/DatabaseConnectionsSettingsWidget/DatabaseConnectionsSettingsWidget';
import { storeCustomerVectorDBConfig } from '../../../../services/storeCustomerVectorDBConfigService';
import { useAuth } from '../../../../context/AuthContext';
import { useToast } from '../../../../context/ToastContext';

// Mocks
jest.mock('../../../../services/storeCustomerVectorDBConfigService');
jest.mock('../../../../context/AuthContext');
jest.mock('../../../../context/ToastContext');

jest.mock('../../../../components/common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus', () => ({
    CustomerVectorDBConfigStatus: ({ vendor }: any) => <div data-testid={`vector-db-status-${vendor}`}>Status</div>
}));

describe('DatabaseConnectionsSettingsWidget', () => {
    const mockUpdateVectorDBConfigStatus = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();
    const mockShowToast = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        (useAuth as jest.Mock).mockReturnValue({
            customerId: '123',
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVectorDBConfigStatus: mockUpdateVectorDBConfigStatus
        });
        (useToast as jest.Mock).mockReturnValue({
            showToast: mockShowToast
        });
        mockGetAccessTokenSilently.mockResolvedValue('token');
    });

    test('renders correctly', () => {
        render(<DatabaseConnectionsSettingsWidget />);
        expect(screen.getByTestId('vector-db-zilliz')).toBeInTheDocument();
        expect(screen.getByText('Milvus Cloud')).toBeInTheDocument();
        // No page-level heading — the settings page provides its own
        expect(screen.queryByText('Database Settings')).not.toBeInTheDocument();
        // Supabase is not offered — only the vector DB connection remains
        expect(screen.queryByText('Supabase')).not.toBeInTheDocument();
    });

    test('validates login status before save', async () => {
        (useAuth as jest.Mock).mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVectorDBConfigStatus: mockUpdateVectorDBConfigStatus
        });

        render(<DatabaseConnectionsSettingsWidget />);
        // Inputs must have values for button to be enabled in first place
        const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
        const tokenInput = screen.getByPlaceholderText('Placeholder token...');

        fireEvent.change(endpointInput, { target: { value: 'https://test.cloud.zilliz.com' } });
        fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

        fireEvent.click(screen.getByText('Save'));

        expect(mockShowToast).toHaveBeenCalledWith('Please log in first.');
        expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled();
    });

    test('validates Zilliz endpoint format', async () => {
        render(<DatabaseConnectionsSettingsWidget />);
        const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
        const tokenInput = screen.getByPlaceholderText('Placeholder token...');

        fireEvent.change(endpointInput, { target: { value: 'invalid-endpoint' } });
        fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

        fireEvent.click(screen.getByText('Save'));

        expect(mockShowToast).toHaveBeenCalledWith('Invalid Zilliz endpoint format.');
        expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled();
    });

    test('validates Zilliz token format', async () => {
        render(<DatabaseConnectionsSettingsWidget />);
        const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
        const tokenInput = screen.getByPlaceholderText('Placeholder token...');

        fireEvent.change(endpointInput, { target: { value: 'https://in03-123.serverless.us-west-2.cloud.zilliz.com' } });
        fireEvent.change(tokenInput, { target: { value: 'short-token' } });

        fireEvent.click(screen.getByText('Save'));

        expect(mockShowToast).toHaveBeenCalledWith('Invalid Zilliz token format. Expected a long hex string.');
        expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled();
    });

    test('saves valid Zilliz config successfully', async () => {
        (storeCustomerVectorDBConfig as jest.Mock).mockResolvedValue({
            configStatus: { updateSuccessful: true, status: 'Success', vendor: 'Zilliz' }
        });

        render(<DatabaseConnectionsSettingsWidget />);
        const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
        const tokenInput = screen.getByPlaceholderText('Placeholder token...');

        fireEvent.change(endpointInput, { target: { value: 'https://in03-123.serverless.us-west-2.cloud.zilliz.com' } });
        fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

        fireEvent.click(screen.getByText('Save'));

        await waitFor(() => {
            expect(storeCustomerVectorDBConfig).toHaveBeenCalledWith('token', {
                vendor: 'Zilliz',
                endpoint: 'https://in03-123.serverless.us-west-2.cloud.zilliz.com',
                token: 'a'.repeat(64)
            });
            expect(mockUpdateVectorDBConfigStatus).toHaveBeenCalled();
            expect(mockShowToast).toHaveBeenCalledWith('Zilliz settings saved successfully.');
        });
    });
});
