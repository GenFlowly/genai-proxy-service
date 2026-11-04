import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { AIProvider } from '../../context/AIContext';
import { AuthProvider } from '../../context/AuthContext';
import { LayoutProvider } from '../../context/LayoutContext';
import { ToastProvider } from '../../context/ToastContext';
import { ConversationProvider } from '../../context/ConversationContext';
import { AIVendor } from '../../constants/vendors';
import AIVendorWidget from '../../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget';
import { getTextGenerationModels } from '../../services/getTextGenerationModelsService';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '../utils/queryWrapper';
import { APIKeyStatus } from '../../models/storeCustomerVendorAPIKeys.models';
import { mockModelsResponse } from '../fixtures/aiConfig';

let testQueryClient: QueryClient;

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
        <QueryClientProvider client={testQueryClient}>
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
        </QueryClientProvider>
    );
};

describe('AIContext UI Integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        testQueryClient = createTestQueryClient();

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
        const { useAI } = require('../../context/AIContext');
        function AIConsumer() {
            const { systemPrompt, setSystemPrompt, selectedInstructionId, setSelectedInstructionId } = useAI();
            return (
                <div>
                    <div data-testid="selected-id">{selectedInstructionId ?? 'none'}</div>
                    <input
                        data-testid="system-prompt-input"
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                    />
                    <button
                        data-testid="select-instruction"
                        onClick={() => {
                            setSelectedInstructionId('inst-1');
                            setSystemPrompt('System Prompt 1');
                        }}
                    >
                        select
                    </button>
                </div>
            );
        }

        await act(async () => {
            customRender(<AIConsumer />);
        });

        expect(screen.getByTestId('selected-id')).toHaveTextContent('none');

        fireEvent.click(screen.getByTestId('select-instruction'));
        expect(screen.getByTestId('selected-id')).toHaveTextContent('inst-1');
        expect(screen.getByTestId('system-prompt-input')).toHaveValue('System Prompt 1');

        fireEvent.change(screen.getByTestId('system-prompt-input'), { target: { value: 'Updated Prompt' } });
        expect(screen.getByTestId('system-prompt-input')).toHaveValue('Updated Prompt');
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

    test('refresh keeps the selected model and reloads the list', async () => {
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

        // 3. The selection is unrelated to the list and survives it
        expect(await screen.findByTestId('model-select-OPENAI')).toBeInTheDocument();
        expect(getTextGenerationModels).toHaveBeenCalledTimes(2);
    });

    test('Seeds thinking level from preferredModels preferences', async () => {
        mockUseAuth.mockReturnValue({
            ...mockUseAuth(),
            aiVendorAPIKeyStatusList: [
                { aiVendor: AIVendor.OPENAI, isAPIKeyValid: true, status: APIKeyStatus.VALID }
            ],
            aiConfigPreferences: {
                preferredModels: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-5', thinkingLevel: 'high' }]
            }
        });
        (getTextGenerationModels as jest.Mock).mockResolvedValue({
            aiVendorModelList: [{ aiVendor: 'OPENAI', modelsList: ['gpt-5'] }]
        });

        await act(async () => {
            customRender(<AIVendorWidget />);
        });

        const thinkingSelect = await screen.findByTestId('thinking-select-OPENAI');
        expect(thinkingSelect).toHaveValue('high');
    });

    test('Falls back to vendor key status thinking level when preferences lack it', async () => {
        // Settings-page saves predating thinkingLevel in preferredModels only
        // stored it on the vendor key item
        mockUseAuth.mockReturnValue({
            ...mockUseAuth(),
            aiVendorAPIKeyStatusList: [
                { aiVendor: AIVendor.OPENAI, isAPIKeyValid: true, status: APIKeyStatus.VALID, thinkingLevel: 'high' }
            ],
            aiConfigPreferences: {
                preferredModels: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-5' }]
            }
        });
        (getTextGenerationModels as jest.Mock).mockResolvedValue({
            aiVendorModelList: [{ aiVendor: 'OPENAI', modelsList: ['gpt-5'] }]
        });

        await act(async () => {
            customRender(<AIVendorWidget />);
        });

        const thinkingSelect = await screen.findByTestId('thinking-select-OPENAI');
        expect(thinkingSelect).toHaveValue('high');
    });

    test('Later preference updates do not overwrite active session selections', async () => {
        const base = mockUseAuth();
        const makeTree = () => (
            <QueryClientProvider client={testQueryClient}>
            <MemoryRouter>
                <ToastProvider>
                    <LayoutProvider>
                        <AuthProvider>
                            <AIProvider>
                                <ConversationProvider>
                                    <AIVendorWidget />
                                </ConversationProvider>
                            </AIProvider>
                        </AuthProvider>
                    </LayoutProvider>
                </ToastProvider>
            </MemoryRouter>
            </QueryClientProvider>
        );
        mockUseAuth.mockReturnValue({
            ...base,
            aiConfigPreferences: {
                preferredModels: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-5' }]
            }
        });
        (getTextGenerationModels as jest.Mock).mockResolvedValue({
            aiVendorModelList: [{ aiVendor: 'OPENAI', modelsList: ['gpt-5', 'gpt-5-mini'] }]
        });

        let utils: ReturnType<typeof render>;
        await act(async () => {
            utils = render(makeTree());
        });

        const select = await screen.findByTestId('model-select-OPENAI');
        expect(select).toHaveValue('gpt-5');

        // User picks a different model this session
        fireEvent.change(select, { target: { value: 'gpt-5-mini' } });

        // Backend preferences change afterwards (e.g. saved from settings)
        mockUseAuth.mockReturnValue({
            ...base,
            aiConfigPreferences: {
                preferredModels: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-5', thinkingLevel: 'low' }]
            }
        });
        await act(async () => {
            utils!.rerender(makeTree());
        });

        expect(screen.getByTestId('model-select-OPENAI')).toHaveValue('gpt-5-mini');
    });

    test('useAI outside AIProvider returns an inert fallback', () => {
        const { useAI } = require('../../context/AIContext');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        let api: any;
        function Orphan() {
            api = useAI();
            return null;
        }

        render(<Orphan />);

        expect(warnSpy).toHaveBeenCalled();
        expect(api.config).toEqual([]);
        // The fallback setters are no-ops and must not throw
        api.setSelectedModelForAIVendor('OPENAI', 'gpt-5');
        api.setThinkingLevelForAIVendor('OPENAI', 'high');
        api.setActiveBlockId('block-1');
        api.setSupplementalText('text');
        api.setSystemPrompt('prompt');
        api.setSelectedInstructionId('inst-1');
        api.setSelectedAgentId('agent-1');
        warnSpy.mockRestore();
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
