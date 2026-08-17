import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { AIProvider } from '../../context/AIContext';
import { AuthProvider } from '../../context/AuthContext';
import { LayoutProvider } from '../../context/LayoutContext';
import { ToastProvider } from '../../context/ToastContext';
import { ConversationProvider } from '../../context/ConversationContext';
import { AIVendor } from '../../constants/vendors';
import AIVendorWidget from '../../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget';
import InstructionWidget from '../../components/widgets/InstructionWidget/InstructionWidget';
import { getTextGenerationModels } from '../../services/getTextGenerationModelsService';
import { MemoryRouter } from 'react-router-dom';
import { APIKeyStatus } from '../../models/storeCustomerVendorAPIKeys.models';
import { mockModelsResponse } from '../fixtures/aiConfig';

// Mock Services
jest.mock('../../services/getTextGenerationModelsService'); // ...
jest.mock('../../services/instructionService');

// Mock AuthContext
const mockUseAuth = jest.fn();
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => mockUseAuth(),
    AuthProvider: ({ children }: any) => children
}));

// Mock TextEditor (Real UI usage)
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    TextEditor: (props: any) => (
        <div data-testid={`${props['data-testid']}-container`}>
            <textarea
                data-testid={props['data-testid'] || 'mock-text-editor'}
                aria-label="System Prompt Editor"
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
            />
        </div>
    ),
}));



const customRender = (ui: React.ReactElement) => {
    return render(
        <MemoryRouter>
            <ToastProvider>
                <LayoutProvider>
                    <AuthProvider>
                        <AIProvider>
                            <ConversationProvider>
                                {ui}
                            </ConversationProvider>
                        </AIProvider>
                    </AuthProvider>
                </LayoutProvider>
            </ToastProvider>
        </MemoryRouter>
    );
};

describe('AIContext UI Integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();

        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            customerId: 'cust-123',
            getAccessTokenSilently: jest.fn().mockResolvedValue('fake-token'),
            aiVendorAPIKeyStatusList: [
                { aiVendor: AIVendor.OPENAI, isAPIKeyValid: true, status: APIKeyStatus.VALID },
                { aiVendor: AIVendor.CLAUDE, isAPIKeyValid: true, status: APIKeyStatus.VALID },
                { aiVendor: AIVendor.GEMINI, isAPIKeyValid: false, status: APIKeyStatus.NOT_SET }
            ],
            aiConfigPreferences: { preferredModels: [] },
            customerInstructions: [
                { id: 'inst-1', name: 'Test Instruction', instruction: 'System Prompt 1', version: 1 }
            ],
            refreshInstructions: jest.fn()
        });

        (getTextGenerationModels as jest.Mock).mockResolvedValue(mockModelsResponse);
    });

    test('Loads models and allows Vendor/Model Selection', async () => {
        await act(async () => {
            customRender(<AIVendorWidget />);
        });

        // 1. Verify Models Fetched
        expect(getTextGenerationModels).toHaveBeenCalled();

        // 2. Select OpenAI
        const openaiToggle = screen.getByTestId('vendor-toggle-OPENAI');
        fireEvent.click(openaiToggle);

        // Assert OpenAI selected (variant changes, or model select appears)
        const openaiSelect = await screen.findByTestId('model-select-OPENAI');
        expect(openaiSelect).toBeInTheDocument();

        // Check default selection (first model)
        expect(openaiSelect).toHaveValue('gpt-4');

        // 3. Change Model
        fireEvent.change(openaiSelect, { target: { value: 'gpt-3.5-turbo' } });
        expect(openaiSelect).toHaveValue('gpt-3.5-turbo');

        // 4. Select Claude (Multi-vendor support)
        const claudeToggle = screen.getByTestId('vendor-toggle-CLAUDE');
        fireEvent.click(claudeToggle);

        // Check if loading or immediate
        const claudeSelect = await screen.findByTestId('model-select-CLAUDE');
        expect(claudeSelect).toHaveValue('claude-3-opus');
    });

    test('Manages System Prompt and Instructions', async () => {
        await act(async () => {
            customRender(<InstructionWidget />);
        });

        // 1. Select Existing Instruction
        // The widget usually starts collapsed or expanded depending on state.
        // Assuming default empty AI context, selectedInstructionId is null -> collapsed.
        const instructionSelect = screen.getByTestId('instruction-selector-collapsed');
        fireEvent.change(instructionSelect, { target: { value: 'inst-1' } });

        // 2. Expand to verify System Prompt
        const editBtn = screen.getByTestId('instruction-edit-button');
        fireEvent.click(editBtn);

        // Verify System Prompt matches instruction
        const textEditor = await screen.findByTestId('system-text-editor');
        expect(textEditor).toHaveValue('System Prompt 1');

        // 3. Edit System Prompt
        fireEvent.change(textEditor, { target: { value: 'Updated Prompt' } });
        expect(textEditor).toHaveValue('Updated Prompt');
    });

    test('Refresh Models triggers API call', async () => {
        await act(async () => {
            customRender(<AIVendorWidget />);
        });

        const refreshBtn = screen.getByTestId('refresh-models-button');

        await act(async () => {
            fireEvent.click(refreshBtn);
        });

        // Should call twice (initial load + refresh)
        expect(getTextGenerationModels).toHaveBeenCalledTimes(2);
    });

    test('resetConfig clears selection on refresh', async () => {
        await act(async () => {
            customRender(<AIVendorWidget />);
        });

        // 1. Select Model
        const openaiToggle = screen.getByTestId('vendor-toggle-OPENAI');
        fireEvent.click(openaiToggle);

        const select = await screen.findByTestId('model-select-OPENAI');
        expect(select).toBeInTheDocument();

        // 2. Click Refresh
        const refreshBtn = screen.getByTestId('refresh-models-button');
        await act(async () => {
            fireEvent.click(refreshBtn);
        });

        // 3. Verify Selection Cleared
        // resetConfig() clears config, so isActive becomes false.
        // The dropdown should be removed.
        expect(select).not.toBeInTheDocument();
    });

    test('Loads cached models from localStorage and updates with API data', async () => {
        // 1. Setup Cache
        const cachedModels = [{
            aiVendor: 'OPENAI',
            modelsList: ['cached-gpt']
        }];
        localStorage.setItem('cust-123_ai_vendor_models', JSON.stringify(cachedModels));

        // 2. Mock API with delay and new data
        const freshModels = {
            aiVendorModelList: [{
                aiVendor: 'OPENAI',
                modelsList: ['fresh-gpt']
            }]
        };

        let resolveApi: (value: any) => void = () => { };
        const apiPromise = new Promise(resolve => {
            resolveApi = resolve;
        });

        (getTextGenerationModels as jest.Mock).mockReturnValue(apiPromise);

        // 3. Render
        await act(async () => {
            customRender(<AIVendorWidget />);
        });

        // 4. Activate Vendor to view models
        const openaiToggle = screen.getByTestId('vendor-toggle-OPENAI');
        fireEvent.click(openaiToggle);

        // 5. Verify Cached Data is shown
        const select = await screen.findByTestId('model-select-OPENAI');
        expect(select).toHaveTextContent('cached-gpt');
        expect(select).not.toHaveTextContent('fresh-gpt');

        // 6. Resolve API
        await act(async () => {
            resolveApi(freshModels);
        });

        // 7. Verify UI Updates to Fresh Data
        await waitFor(() => {
            expect(select).toHaveTextContent('fresh-gpt');
            expect(select).not.toHaveTextContent('cached-gpt');
        });
    });
});

// Coverage refresh
// Trigger coverage run
