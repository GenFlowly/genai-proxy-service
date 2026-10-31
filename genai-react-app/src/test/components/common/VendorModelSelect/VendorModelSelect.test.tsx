import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VendorModelSelect from '../../../../components/common/VendorModelSelect/VendorModelSelect';
import { useAuth } from '../../../../context/AuthContext';
import { getTextGenerationModels } from '../../../../services/getTextGenerationModelsService';
import { AIVendor } from '../../../../constants/vendors';
import { APIKeyStatus } from '../../../../models/storeCustomerVendorAPIKeys.models';
import { withQueryClient } from '../../../utils/queryWrapper';
import '@testing-library/jest-dom';

jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn()
}));

jest.mock('../../../../services/getTextGenerationModelsService', () => ({
    getTextGenerationModels: jest.fn()
}));

describe('VendorModelSelect Component', () => {
    const mockUseAuth = useAuth as jest.Mock;
    const mockGetModels = getTextGenerationModels as jest.Mock;
    const mockOnChange = jest.fn();

    const mockGetAccessTokenSilently = jest.fn();

    const defaultAuthValues = {
        getAccessTokenSilently: mockGetAccessTokenSilently,
        customerId: 'customer-123',
        isAuthenticated: true,
        aiVendorAPIKeyStatusList: [
            { aiVendor: AIVendor.CLAUDE, status: APIKeyStatus.VALID },
            { aiVendor: AIVendor.OPENAI, status: APIKeyStatus.NOT_SET },
            { aiVendor: AIVendor.GEMINI, status: APIKeyStatus.VALID }
        ]
    };

    const mockModelsResponse = {
        aiVendorModelList: [
            { aiVendor: AIVendor.CLAUDE, modelsList: ['claude-3-5-sonnet', 'claude-3-opus'] },
            { aiVendor: AIVendor.GEMINI, modelsList: ['gemini-1.5-pro'] }
        ]
    };

    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        mockGetAccessTokenSilently.mockResolvedValue('mock-token');
        mockUseAuth.mockReturnValue(defaultAuthValues);
        mockGetModels.mockResolvedValue(mockModelsResponse);
    });


    test('renders all vendor buttons and shows status hint for disabled vendors', async () => {
        render(withQueryClient(<VendorModelSelect vendor={null} model="" onChange={mockOnChange} />));

        expect(screen.getByTestId('vendor-select-CLAUDE')).toBeInTheDocument();
        expect(screen.getByTestId('vendor-select-OPENAI')).toBeInTheDocument();
        expect(screen.getByTestId('vendor-select-GEMINI')).toBeInTheDocument();

        expect(screen.getByText(APIKeyStatus.NOT_SET)).toBeInTheDocument();
    });

    test('fetches models on mount and caches in localStorage', async () => {
        render(withQueryClient(<VendorModelSelect vendor={null} model="" onChange={mockOnChange} />));

        await waitFor(() => {
            expect(mockGetModels).toHaveBeenCalledWith('mock-token', 'customer-123', { aiVendor: Object.values(AIVendor) });
        });

        expect(localStorage.getItem('customer-123_ai_vendor_models')).not.toBeNull();
    });

    test('paints models from localStorage immediately while revalidating', async () => {
        localStorage.setItem('customer-123_ai_vendor_models', JSON.stringify([
            { aiVendor: AIVendor.CLAUDE, modelsList: ['cached-model'] },
        ]));

        render(withQueryClient(<VendorModelSelect vendor={AIVendor.CLAUDE} model="cached-model" onChange={mockOnChange} />));

        // The cached copy renders synchronously (placeholder data)…
        expect(screen.getByTestId('agent-model-select')).toBeInTheDocument();
        // …and a revalidating fetch still fires (stale-while-revalidate).
        await waitFor(() => {
            expect(mockGetModels).toHaveBeenCalled();
        });
    });

    test('calls onChange with vendor and first model when an enabled vendor is clicked', async () => {
        render(withQueryClient(<VendorModelSelect vendor={null} model="" onChange={mockOnChange} />));

        await waitFor(() => {
            expect(mockGetModels).toHaveBeenCalled();
        });

        const claudeBtn = screen.getByTestId('vendor-select-CLAUDE');
        await userEvent.click(claudeBtn);

        expect(mockOnChange).toHaveBeenCalledWith(AIVendor.CLAUDE, 'claude-3-5-sonnet');
    });

    test('does not call onChange when a disabled vendor is clicked', async () => {
        render(withQueryClient(<VendorModelSelect vendor={null} model="" onChange={mockOnChange} />));

        const openAIBtn = screen.getByTestId('vendor-select-OPENAI');
        await userEvent.click(openAIBtn);

        expect(mockOnChange).not.toHaveBeenCalled();
    });

    test('deselects vendor when clicking the currently active vendor', async () => {
        render(withQueryClient(<VendorModelSelect vendor={AIVendor.CLAUDE} model="claude-3-5-sonnet" onChange={mockOnChange} />));

        const claudeBtn = screen.getByTestId('vendor-select-CLAUDE');
        await userEvent.click(claudeBtn);

        expect(mockOnChange).toHaveBeenCalledWith(null, '');
    });

    test('renders model select dropdown when vendor is selected and enabled', async () => {
        localStorage.setItem('customer-123_ai_vendor_models', JSON.stringify(mockModelsResponse.aiVendorModelList));

        render(withQueryClient(<VendorModelSelect vendor={AIVendor.CLAUDE} model="claude-3-5-sonnet" onChange={mockOnChange} />));

        const select = await screen.findByTestId('agent-model-select');
        expect(select).toBeInTheDocument();
        expect(select).toHaveValue('claude-3-5-sonnet');

        await userEvent.selectOptions(select, 'claude-3-opus');
        expect(mockOnChange).toHaveBeenCalledWith(AIVendor.CLAUDE, 'claude-3-opus');
    });

    test('shows "No models available" when vendor has no models', async () => {
        mockGetModels.mockResolvedValue({
            aiVendorModelList: [{ aiVendor: AIVendor.CLAUDE, modelsList: [] }],
        });

        render(withQueryClient(<VendorModelSelect vendor={AIVendor.CLAUDE} model="" onChange={mockOnChange} />));

        expect(await screen.findByText('No models available')).toBeInTheDocument();
    });

    test('does not fetch models if unauthenticated', async () => {
        mockUseAuth.mockReturnValue({
            ...defaultAuthValues,
            isAuthenticated: false
        });

        render(withQueryClient(<VendorModelSelect vendor={null} model="" onChange={mockOnChange} />));

        expect(mockGetModels).not.toHaveBeenCalled();
    });
});
