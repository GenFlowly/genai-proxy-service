import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AIVendorWidget from '../../../../../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget';
import { useSidebarWidget } from '../../../../../hooks/useSidebarWidget';
import { useToast } from '../../../../../context/ToastContext';
import { AIVendor } from '../../../../../constants/vendors';
import { APIKeyStatus } from '../../../../../models/storeCustomerVendorAPIKeys.models';
import * as refreshService from '../../../../../services/getTextGenerationModelsService';
import * as configService from '../../../../../services/saveAIConfigService';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../../hooks/useSidebarWidget');
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

jest.mock('../../../../../components/common/BrandName/BrandName', () => ({
    OpenAIBrandName: () => <span>OpenAI</span>,
    ClaudeBrandName: () => <span>Claude</span>,
    GeminiBrandName: () => <span>Gemini</span>,
    CollapsedOpenAIBrandName: () => <span>O</span>,
    CollapsedClaudeBrandName: () => <span>C</span>,
    CollapsedGeminiBrandName: () => <span>G</span>
}));

describe('AIVendorWidget', () => {
    const mockUseSidebarWidget = useSidebarWidget as jest.Mock;
    const mockUseToast = useToast as jest.Mock;
    const mockGetTextGenerationModels = refreshService.getTextGenerationModels as jest.Mock;
    const mockSaveAIConfigPreferences = configService.saveAIConfigPreferences as jest.Mock;
    const mockClearAllModelCache = refreshService.clearAllModelCache as jest.Mock;
    const mockShowToast = jest.fn();

    const mockSetSelectedModelForAIVendor = jest.fn();
    const mockResetConfig = jest.fn();
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
                resetConfig: mockResetConfig
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

        // Mock model fetch response
        mockGetTextGenerationModels.mockResolvedValue({
            aiVendorModelList: [
                { aiVendor: AIVendor.OPENAI, modelsList: ['gpt-4', 'gpt-3.5-turbo'] },
                { aiVendor: AIVendor.CLAUDE, modelsList: ['claude-2'] }
            ]
        });
    });

    test('renders only vendors with a valid key and toggles correctly', async () => {
        render(<AIVendorWidget />);

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
                resetConfig: mockResetConfig
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

        render(<AIVendorWidget />);

        expect(screen.queryByTestId(`vendor-toggle-${AIVendor.OPENAI}`)).not.toBeInTheDocument();
        expect(screen.getByText('No API keys set')).toBeInTheDocument();
    });

    test('activates vendor when enabled', async () => {
        mockUseSidebarWidget.mockReturnValue({
            ai: {
                config: [{ aiVendor: AIVendor.OPENAI, model: '' }], // Inactive
                setSelectedModelForAIVendor: mockSetSelectedModelForAIVendor,
                resetConfig: mockResetConfig
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

        render(<AIVendorWidget />);
        await waitFor(() => expect(mockGetTextGenerationModels).toHaveBeenCalled());

        const openAIToggle = screen.getByTestId(`vendor-toggle-${AIVendor.OPENAI}`);
        fireEvent.click(openAIToggle);

        // Should select first model 'gpt-4'
        expect(mockSetSelectedModelForAIVendor).toHaveBeenCalledWith(AIVendor.OPENAI, 'gpt-4');
    });

    test('handles model selection change', async () => {
        render(<AIVendorWidget />);
        await waitFor(() => expect(mockGetTextGenerationModels).toHaveBeenCalled());

        const select = screen.getByTestId(`model-select-${AIVendor.OPENAI}`);
        fireEvent.change(select, { target: { value: 'gpt-3.5-turbo' } });

        expect(mockSetSelectedModelForAIVendor).toHaveBeenCalledWith(AIVendor.OPENAI, 'gpt-3.5-turbo');
    });

    test('refreshes models on button click', async () => {
        render(<AIVendorWidget />);
        const refreshBtn = screen.getByTestId('refresh-models-button');

        fireEvent.click(refreshBtn);

        await waitFor(() => {
            expect(mockResetConfig).toHaveBeenCalled();
            expect(mockClearAllModelCache).toHaveBeenCalled();
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
                resetConfig: mockResetConfig
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

        render(<AIVendorWidget />);
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
