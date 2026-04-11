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
        expect(screen.getByText('Database Settings')).toBeInTheDocument();
        expect(screen.getByText('Milvus Cloud')).toBeInTheDocument();
        expect(screen.getByText('Supabase')).toBeInTheDocument();
    });

    test('validates login status before save', async () => {
        (useAuth as jest.Mock).mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVectorDBConfigStatus: mockUpdateVectorDBConfigStatus
        });

        render(<DatabaseConnectionsSettingsWidget />);
        // Inputs must have values for button to be enabled in first place (for Zilliz)
        const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
        const tokenInput = screen.getByPlaceholderText('Placeholder token...');
        
        fireEvent.change(endpointInput, { target: { value: 'https://test.cloud.zilliz.com' } });
        fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

        const buttons = screen.getAllByText('Save');
        fireEvent.click(buttons[0]); // Zilliz

        expect(mockShowToast).toHaveBeenCalledWith('Please log in first.');
        expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled();
    });

    test('validates Zilliz endpoint format', async () => {
        render(<DatabaseConnectionsSettingsWidget />);
        const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
        const tokenInput = screen.getByPlaceholderText('Placeholder token...');
        
        fireEvent.change(endpointInput, { target: { value: 'invalid-endpoint' } });
        fireEvent.change(tokenInput, { target: { value: 'a'.repeat(64) } });

        const buttons = screen.getAllByText('Save');
        fireEvent.click(buttons[0]);

        expect(mockShowToast).toHaveBeenCalledWith('Invalid Zilliz endpoint format.');
        expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled();
    });

    test('validates Zilliz token format', async () => {
        render(<DatabaseConnectionsSettingsWidget />);
        const endpointInput = screen.getByPlaceholderText('https://in03-....zillizcloud.com');
        const tokenInput = screen.getByPlaceholderText('Placeholder token...');
        
        fireEvent.change(endpointInput, { target: { value: 'https://in03-123.serverless.us-west-2.cloud.zilliz.com' } });
        fireEvent.change(tokenInput, { target: { value: 'short-token' } });

        const buttons = screen.getAllByText('Save');
        fireEvent.click(buttons[0]);

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

        const buttons = screen.getAllByText('Save');
        fireEvent.click(buttons[0]);

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

    test('validates Supabase endpoint format', async () => {
        render(<DatabaseConnectionsSettingsWidget />);
        const endpointInput = screen.getByPlaceholderText('https://your-project.supabase.co');
        const tokenInput = screen.getByPlaceholderText('your-anon-key');
        
        fireEvent.change(endpointInput, { target: { value: 'invalid-url' } });
        fireEvent.change(tokenInput, { target: { value: 'key' } });

        const buttons = screen.getAllByText('Save');
        fireEvent.click(buttons[1]); // Supabase

        expect(mockShowToast).toHaveBeenCalledWith('Invalid Supabase endpoint format. Please enter a valid URL.');
        expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled();
    });

    test('saves valid Supabase config successfully', async () => {
        (storeCustomerVectorDBConfig as jest.Mock).mockResolvedValue({
            configStatus: { updateSuccessful: true, status: 'Success', vendor: 'Supabase' }
        });

        render(<DatabaseConnectionsSettingsWidget />);
        const endpointInput = screen.getByPlaceholderText('https://your-project.supabase.co');
        const tokenInput = screen.getByPlaceholderText('your-anon-key');
        
        fireEvent.change(endpointInput, { target: { value: 'https://xyz.supabase.co' } });
        fireEvent.change(tokenInput, { target: { value: 'some-key' } });

        const buttons = screen.getAllByText('Save');
        fireEvent.click(buttons[1]);

        await waitFor(() => {
            expect(storeCustomerVectorDBConfig).toHaveBeenCalledWith('token', {
                vendor: 'Supabase',
                endpoint: 'https://xyz.supabase.co',
                token: 'some-key'
            });
            expect(mockUpdateVectorDBConfigStatus).toHaveBeenCalled();
            expect(mockShowToast).toHaveBeenCalledWith('Supabase settings saved successfully.');
        });
    });
});
