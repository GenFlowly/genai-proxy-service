import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import AIVendorWidget from '../../../../../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget';
import { useSidebarWidget } from '../../../../../hooks/useSidebarWidget';
import { useAuth } from '../../../../../context/AuthContext';
import { withQueryClient } from '../../../../utils/queryWrapper';
import { useToast } from '../../../../../context/ToastContext';
import { AIVendor } from '../../../../../constants/vendors';
import { APIKeyStatus } from '../../../../../models/storeCustomerVendorAPIKeys.models';
import * as refreshService from '../../../../../services/getTextGenerationModelsService';
import * as configService from '../../../../../services/saveAIConfigService';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../../hooks/useSidebarWidget');
jest.mock('../../../../../context/AuthContext');
jest.mock('../../../../../context/ToastContext');
jest.mock('../../../../../services/getTextGenerationModelsService');
jest.mock('../../../../../services/saveAIConfigService');

// Mock child components
jest.mock('../../../../../components/common/SidebarWidgetContainer/SidebarWidgetContainer', () =>
    ({ children, header, headerCollapsed, 'data-testid': testId }: any) => (
        <div data-testid={testId}>
            <div data-testid="widget-header">{header}</div>
            <div data-testid="widget-content">{children}</div>
        </div>
    )
);

jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    PillButton: ({ label, onClick, variant, disabled, 'data-testid': testId }: any) => (
        <button data-testid={testId} onClick={onClick} disabled={disabled} className={`pillButton ${variant}`}>
            {label}
        </button>
    ),
}));

// Real display names come from the provider catalog; the mock uses fixed
// per-vendor labels so widget behavior can be asserted deterministically.
jest.mock('../../../../../components/common/BrandName/BrandName', () => ({
    VendorBrandName: ({ vendorId }: any) => (
        <span>{({ OPENAI: 'OpenAI', CLAUDE: 'Claude', GEMINI: 'Gemini' } as any)[vendorId] ?? vendorId}</span>
    ),
    CollapsedVendorBrandName: ({ vendorId }: any) => (
        <span>{({ OPENAI: 'O', CLAUDE: 'C', GEMINI: 'G' } as any)[vendorId] ?? vendorId.charAt(0)}</span>
    )
}));

describe('AIVendorWidget', () => {
    const mockUseSidebarWidget = useSidebarWidget as jest.Mock;
    const mockUseAuth = useAuth as jest.Mock;
    const mockUseToast = useToast as jest.Mock;
    const mockGetTextGenerationModels = refreshService.getTextGenerationModels as jest.Mock;
    const mockSaveAIConfigPreferences = configService.saveAIConfigPreferences as jest.Mock;
    const mockShowToast = jest.fn();

    const mockSetSelectedModelForAIVendor = jest.fn();
    const mockGetAccessTokenSilently = jest.fn().mockResolvedValue('token');

    beforeEach(() => {
        jest.clearAllMocks();

        mockUseToast.mockReturnValue({ showToast: mockShowToast });

        mockUseSidebarWidget.mockReturnValue({
            ai: {
                config: [
                    { aiVendor: AIVendor.OPENAI, model: 'gpt-4' },
                    { aiVendor: AIVendor.CLAUDE, model: '' },
                    { aiVendor: AIVendor.GEMINI, model: '' }
                ],
                setSelectedModelForAIVendor: mockSetSelectedModelForAIVendor,
            },
            auth: {
                getAccessTokenSilently: mockGetAccessTokenSilently,
                customerId: 'cust-123',
                isAuthenticated: true,
                aiVendorAPIKeyStatusList: [
                    { aiVendor: AIVendor.OPENAI, status: APIKeyStatus.VALID, isAPIKeyValid: true },
                    { aiVendor: AIVendor.CLAUDE, status: APIKeyStatus.NOT_SET, isAPIKeyValid: false }
                ],
                aiConfigPreferences: null
            }
        });

        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            isOnboarding: false,
            customerId: 'cust-123',
            cacheVersions: null,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        });
        localStorage.clear();

        // Mock model fetch response
        mockGetTextGenerationModels.mockResolvedValue({
            aiVendorModelList: [
                { aiVendor: AIVendor.OPENAI, modelsList: ['gpt-4', 'gpt-3.5-turbo'] },
                { aiVendor: AIVendor.CLAUDE, modelsList: ['claude-2'] }
            ]
        });
    });

    test('renders only vendors with a valid key and toggles correctly', async () => {
        render(withQueryClient(<AIVendorWidget />));

        // OpenAI has a valid key → rendered; Claude's key is NOT_SET → hidden
        expect(screen.getByText('OpenAI')).toBeInTheDocument();
        expect(screen.queryByTestId(`vendor-toggle-${AIVendor.CLAUDE}`)).not.toBeInTheDocument();

        // Check active state (OpenAI mocked as having model 'gpt-4')
        const openAIToggle = screen.getByTestId(`vendor-toggle-${AIVendor.OPENAI}`);
        expect(openAIToggle).toHaveClass('primary'); // Assuming PillButton variant='primary' adds this class or check via other means if needed.
        // Better: We check interaction logic

        // Deactivate OpenAI
        fireEvent.click(openAIToggle);
        expect(mockSetSelectedModelForAIVendor).toHaveBeenCalledWith(AIVendor.OPENAI, '');

        await waitFor(() => expect(mockGetTextGenerationModels).toHaveBeenCalled());
    });

    test('shows the no-keys hint when no vendor has a valid key', () => {
        mockUseSidebarWidget.mockReturnValue({
            ai: {
                config: [],
                setSelectedModelForAIVendor: mockSetSelectedModelForAIVendor,
            },
            auth: {
                getAccessTokenSilently: mockGetAccessTokenSilently,
                customerId: 'cust-123',
                isAuthenticated: true,
                aiVendorAPIKeyStatusList: [
                    { aiVendor: AIVendor.OPENAI, status: APIKeyStatus.NOT_SET, isAPIKeyValid: false }
                ]
            }
        });

        render(withQueryClient(<AIVendorWidget />));

        expect(screen.queryByTestId(`vendor-toggle-${AIVendor.OPENAI}`)).not.toBeInTheDocument();
        expect(screen.getByText('No API keys set')).toBeInTheDocument();
    });

    test('activates vendor when enabled', async () => {
        mockUseSidebarWidget.mockReturnValue({
            ai: {
                config: [{ aiVendor: AIVendor.OPENAI, model: '' }], // Inactive
                setSelectedModelForAIVendor: mockSetSelectedModelForAIVendor,
            },
            auth: {
                getAccessTokenSilently: mockGetAccessTokenSilently,
                customerId: 'cust-123',
                isAuthenticated: true,
                aiVendorAPIKeyStatusList: [
                    { aiVendor: AIVendor.OPENAI, status: APIKeyStatus.VALID, isAPIKeyValid: true }
                ]
            }
        });

        render(withQueryClient(<AIVendorWidget />));
        await waitFor(() => expect(mockGetTextGenerationModels).toHaveBeenCalled());

        const openAIToggle = screen.getByTestId(`vendor-toggle-${AIVendor.OPENAI}`);
        fireEvent.click(openAIToggle);

        // Should select first model 'gpt-4'
        expect(mockSetSelectedModelForAIVendor).toHaveBeenCalledWith(AIVendor.OPENAI, 'gpt-4');
    });

    test('handles model selection change', async () => {
        render(withQueryClient(<AIVendorWidget />));
        await waitFor(() => expect(mockGetTextGenerationModels).toHaveBeenCalled());

        const select = screen.getByTestId(`model-select-${AIVendor.OPENAI}`);
        fireEvent.change(select, { target: { value: 'gpt-3.5-turbo' } });

        expect(mockSetSelectedModelForAIVendor).toHaveBeenCalledWith(AIVendor.OPENAI, 'gpt-3.5-turbo');
    });

    test('refresh forgets the cached list and keeps the selection', async () => {
        render(withQueryClient(<AIVendorWidget />));
        await waitFor(() => expect(mockGetTextGenerationModels).toHaveBeenCalledTimes(1));
        expect(await screen.findByTestId('model-select-OPENAI')).toBeInTheDocument();
        localStorage.setItem('cust-123_ai_vendor_models', JSON.stringify([{ aiVendor: 'OPENAI', modelsList: ['stale'] }]));
        mockSetSelectedModelForAIVendor.mockClear();
        let finishFetch: (value: unknown) => void = () => {};
        mockGetTextGenerationModels.mockReturnValueOnce(new Promise(resolve => { finishFetch = resolve; }));

        fireEvent.click(screen.getByTestId('refresh-models-button'));

        // The old list is gone while the new one loads, with no "no models" flash
        await waitFor(() => expect(mockGetTextGenerationModels).toHaveBeenCalledTimes(2));
        expect(localStorage.getItem('cust-123_ai_vendor_models')).toBeNull();
        expect(screen.queryByTestId('model-select-OPENAI')).not.toBeInTheDocument();
        expect(screen.queryByText('sidebar.aiVendorWidget.noModelsAvailable')).not.toBeInTheDocument();

        await act(async () => {
            finishFetch({ aiVendorModelList: [{ aiVendor: AIVendor.OPENAI, modelsList: ['gpt-4', 'gpt-new'] }] });
        });

        const select = await screen.findByTestId('model-select-OPENAI');
        expect(select).toHaveValue('gpt-4');
        expect(screen.getByText('gpt-new')).toBeInTheDocument();
        expect(mockSetSelectedModelForAIVendor).not.toHaveBeenCalled();
    });

    test('refreshes models on button click', async () => {
        render(withQueryClient(<AIVendorWidget />));
        // A refetch during the initial in-flight fetch is deduped by
        // react-query — wait for the mount fetch to land before clicking.
        await waitFor(() => expect(mockGetTextGenerationModels).toHaveBeenCalledTimes(1));
        const refreshBtn = screen.getByTestId('refresh-models-button');

        fireEvent.click(refreshBtn);

        await waitFor(() => {
            expect(mockGetTextGenerationModels).toHaveBeenCalledTimes(2); // Once on mount, once on click
        });
    });

    test('saves current preferences', async () => {
        // Explicitly setup mock for this test to ensure token is returned
        const mockTokenFn = jest.fn().mockResolvedValue('token');
        mockUseSidebarWidget.mockReturnValue({
            ai: {
                config: [
                    { aiVendor: AIVendor.OPENAI, model: 'gpt-4' } // Active selection
                ],
                setSelectedModelForAIVendor: mockSetSelectedModelForAIVendor,
            },
            auth: {
                getAccessTokenSilently: mockTokenFn,
                customerId: 'cust-123',
                isAuthenticated: true,
                aiVendorAPIKeyStatusList: [
                    { aiVendor: AIVendor.OPENAI, status: APIKeyStatus.VALID, isAPIKeyValid: true }
                ],
                aiConfigPreferences: null
            }
        });

        render(withQueryClient(<AIVendorWidget />));
        const saveBtn = screen.getByLabelText('Set as default');

        fireEvent.click(saveBtn);

        await waitFor(() => {
            expect(mockSaveAIConfigPreferences).toHaveBeenCalledWith('token', {
                aiConfigPreferences: {
                    preferredModels: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-4' }]
                }
            });
            expect(mockShowToast).toHaveBeenCalledWith('Preferences saved successfully!');
        });
    });
});
