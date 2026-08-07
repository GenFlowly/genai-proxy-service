import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemorySettings } from './MemorySettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { storeCustomerVectorDBConfig } from '../../../services/storeCustomerVectorDBConfigService';
import { storeCustomerSupabaseConfig } from '../../../services/storeCustomerSupabaseConfigService';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/storeCustomerVectorDBConfigService');
jest.mock('../../../services/storeCustomerSupabaseConfigService');
jest.mock('../../../components/common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus', () => ({
    CustomerVectorDBConfigStatus: () => <div data-testid="vector-db-status" />
}));
jest.mock('../../../components/common/CustomerSupabaseConfigStatus/CustomerSupabaseConfigStatus', () => ({
    CustomerSupabaseConfigStatus: () => <div data-testid="supabase-status" />
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockStoreCustomerVectorDBConfig = storeCustomerVectorDBConfig as jest.Mock;
const mockStoreCustomerSupabaseConfig = storeCustomerSupabaseConfig as jest.Mock;

describe('MemorySettings', () => {
    const mockShowToast = jest.fn();
    const mockGetAccessTokenSilently = jest.fn().mockResolvedValue('test-token');
    const mockUpdateVectorDBConfigStatus = jest.fn();
    const mockUpdateSupabaseConfigStatus = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseToast.mockReturnValue({ showToast: mockShowToast });
        mockUseAuth.mockReturnValue({
            customerId: 'cust-123',
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVectorDBConfigStatus: mockUpdateVectorDBConfigStatus,
            updateSupabaseConfigStatus: mockUpdateSupabaseConfigStatus,
        });
    });

    test('renders correctly', () => {
        render(<MemorySettings />);
        expect(screen.getByText('Memory Settings')).toBeInTheDocument();
        expect(screen.getByText('Milvus Cloud')).toBeInTheDocument();
        expect(screen.getByText('Supabase')).toBeInTheDocument();
    });

    test('validates Zilliz empty fields', async () => {
        render(<MemorySettings />);
        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        // Zilliz save is the first button, disabled by default if fields are empty
        expect(saveButtons[0]).toBeDisabled();
    });

    test('validates Zilliz endpoint format', async () => {
        render(<MemorySettings />);
        const inputs = screen.getAllByRole('textbox');
        // Zilliz Endpoint is inputs[0], Zilliz Token is inputs[1]
        await userEvent.type(inputs[0], 'invalid-endpoint');
        await userEvent.type(inputs[1], 'some-token');

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        expect(saveButtons[0]).not.toBeDisabled();
        await userEvent.click(saveButtons[0]);
        
        expect(mockShowToast).toHaveBeenCalledWith('Invalid Zilliz endpoint format.');
    });

    test('saves Zilliz config successfully', async () => {
        mockStoreCustomerVectorDBConfig.mockResolvedValueOnce({
            configStatus: { updateSuccessful: true }
        });

        render(<MemorySettings />);
        const inputs = screen.getAllByRole('textbox');
        await userEvent.type(inputs[0], 'https://in03-xyz.serverless.gcp-us-west1.cloud.zilliz.com');
        await userEvent.type(inputs[1], '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'); // 64 chars

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        await userEvent.click(saveButtons[0]);

        await waitFor(() => {
            expect(mockStoreCustomerVectorDBConfig).toHaveBeenCalled();
            expect(mockUpdateVectorDBConfigStatus).toHaveBeenCalled();
            expect(mockShowToast).toHaveBeenCalledWith('Zilliz settings saved successfully.');
        });
    });

    test('validates Zilliz token format', async () => {
        render(<MemorySettings />);
        const inputs = screen.getAllByRole('textbox');
        await userEvent.type(inputs[0], 'https://in03-xyz.serverless.gcp-us-west1.cloud.zilliz.com');
        await userEvent.type(inputs[1], 'short-token');

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        await userEvent.click(saveButtons[0]);
        
        expect(mockShowToast).toHaveBeenCalledWith('Invalid Zilliz token format. Expected a long hex string.');
    });

    test('handles Zilliz save error', async () => {
        mockStoreCustomerVectorDBConfig.mockRejectedValueOnce(new Error('API failed'));

        render(<MemorySettings />);
        const inputs = screen.getAllByRole('textbox');
        await userEvent.type(inputs[0], 'https://in03-xyz.serverless.gcp-us-west1.cloud.zilliz.com');
        await userEvent.type(inputs[1], '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        await userEvent.click(saveButtons[0]);

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('API failed');
        });
    });

    test('shows toast if unauthenticated for Zilliz', async () => {
        mockUseAuth.mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVectorDBConfigStatus: mockUpdateVectorDBConfigStatus,
            updateSupabaseConfigStatus: mockUpdateSupabaseConfigStatus,
        });

        render(<MemorySettings />);
        const inputs = screen.getAllByRole('textbox');
        await userEvent.type(inputs[0], 'https://in03-xyz.serverless.gcp-us-west1.cloud.zilliz.com');
        await userEvent.type(inputs[1], '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        await userEvent.click(saveButtons[0]);

        expect(mockShowToast).toHaveBeenCalledWith('Please log in first.');
    });

    test('validates Supabase empty fields', async () => {
        render(<MemorySettings />);
        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        expect(saveButtons[1]).toBeDisabled();
    });

    test('validates Supabase endpoint format', async () => {
        render(<MemorySettings />);
        // inputs[2] is Supabase Endpoint, inputs[3] is Key
        const textInputs = screen.getAllByRole('textbox');
        // Password is input type password
        const passwordInput = screen.getByPlaceholderText('PostgreSQL Database Password');

        await userEvent.type(textInputs[2], 'invalid-url');
        await userEvent.type(textInputs[3], 'some-key');
        await userEvent.type(passwordInput, 'some-password');

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        await userEvent.click(saveButtons[1]);
        
        expect(mockShowToast).toHaveBeenCalledWith('Invalid Supabase endpoint format. Please enter a valid URL.');
    });

    test('saves Supabase config successfully', async () => {
        mockStoreCustomerSupabaseConfig.mockResolvedValueOnce({
            configStatus: { updateSuccessful: true }
        });

        render(<MemorySettings />);
        const textInputs = screen.getAllByRole('textbox');
        const passwordInput = screen.getByPlaceholderText('PostgreSQL Database Password');

        await userEvent.type(textInputs[2], 'https://project.supabase.co');
        await userEvent.type(textInputs[3], 'valid-key');
        await userEvent.type(passwordInput, 'valid-password');

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        await userEvent.click(saveButtons[1]);

        await waitFor(() => {
            expect(mockStoreCustomerSupabaseConfig).toHaveBeenCalled();
            expect(mockUpdateSupabaseConfigStatus).toHaveBeenCalled();
            expect(mockShowToast).toHaveBeenCalledWith('Supabase settings saved successfully.');
        });
    });

    test('handles Supabase save error', async () => {
        mockStoreCustomerSupabaseConfig.mockRejectedValueOnce(new Error('Supabase failed'));

        render(<MemorySettings />);
        const textInputs = screen.getAllByRole('textbox');
        const passwordInput = screen.getByPlaceholderText('PostgreSQL Database Password');

        await userEvent.type(textInputs[2], 'https://project.supabase.co');
        await userEvent.type(textInputs[3], 'valid-key');
        await userEvent.type(passwordInput, 'valid-password');

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        await userEvent.click(saveButtons[1]);

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('Supabase failed');
        });
    });

    test('shows toast if unauthenticated for Supabase', async () => {
        mockUseAuth.mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
            updateVectorDBConfigStatus: mockUpdateVectorDBConfigStatus,
            updateSupabaseConfigStatus: mockUpdateSupabaseConfigStatus,
        });

        render(<MemorySettings />);
        const textInputs = screen.getAllByRole('textbox');
        const passwordInput = screen.getByPlaceholderText('PostgreSQL Database Password');

        await userEvent.type(textInputs[2], 'https://project.supabase.co');
        await userEvent.type(textInputs[3], 'valid-key');
        await userEvent.type(passwordInput, 'valid-password');

        const saveButtons = screen.getAllByRole('button', { name: /save/i });
        await userEvent.click(saveButtons[1]);

        expect(mockShowToast).toHaveBeenCalledWith('Please log in first.');
    });
});
