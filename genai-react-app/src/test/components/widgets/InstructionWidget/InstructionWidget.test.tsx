import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import InstructionWidget from '../../../../components/widgets/InstructionWidget/InstructionWidget';
import { useAI } from '../../../../context/AIContext';
import { useAuth } from '../../../../context/AuthContext';
import { useLayout } from '../../../../context/LayoutContext';
import { useAuth0 } from '@auth0/auth0-react';
import { createInstruction, getInstructionVersion } from '../../../../services/instructionService';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../context/AIContext');
jest.mock('../../../../context/AuthContext');
jest.mock('../../../../context/LayoutContext');
jest.mock('@auth0/auth0-react', () => ({
    useAuth0: jest.fn()
}));
jest.mock('../../../../services/instructionService');

// Mock PromptEditor
jest.mock('../../../../components/widgets/PromptEditorWidget/PromptEditor', () => ({ value, onChange, 'data-testid': testId }: any) => (
    <textarea
        data-testid={testId || 'prompt-editor'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
    />
));

describe('InstructionWidget Component', () => {
    const mockUseAI = useAI as jest.Mock;
    const mockUseAuth = useAuth as jest.Mock;
    const mockUseLayout = useLayout as jest.Mock;
    const mockUseAuth0 = useAuth0 as jest.Mock;
    const mockCreateInstruction = createInstruction as jest.Mock;
    const mockGetInstructionVersion = getInstructionVersion as jest.Mock;

    const navFunctions = {
        setSystemPrompt: jest.fn(),
        setSelectedInstructionId: jest.fn(),
        setInstructionWidgetExpanded: jest.fn(),
        refreshInstructions: jest.fn(),
        updateInstruction: jest.fn()
    };

    const mockInstructions = [
        { id: 'inst-1', name: 'Instruction 1', version: 1, instruction: 'System Prompt 1' },
        { id: 'inst-1', name: 'Instruction 1', version: 2, instruction: 'System Prompt 1 v2' }
    ];

    beforeEach(() => {
        jest.clearAllMocks();

        mockUseAI.mockReturnValue({
            systemPrompt: '',
            setSystemPrompt: navFunctions.setSystemPrompt,
            selectedInstructionId: null,
            setSelectedInstructionId: navFunctions.setSelectedInstructionId
        });

        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{ isAPIKeyValid: true }],
            customerInstructions: mockInstructions,
            refreshInstructions: navFunctions.refreshInstructions,
            updateInstruction: navFunctions.updateInstruction
        });

        mockUseLayout.mockReturnValue({
            isInstructionWidgetExpanded: false,
            setInstructionWidgetExpanded: navFunctions.setInstructionWidgetExpanded
        });

        mockUseAuth0.mockReturnValue({
            getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token')
        });
    });

    test('renders collapsed state by default', () => {
        render(<InstructionWidget />);
        expect(screen.getByTestId('instruction-widget-collapsed')).toBeInTheDocument();
        expect(screen.getByTestId('instruction-selector-collapsed')).toBeInTheDocument();
        expect(screen.getByTestId('instruction-edit-button')).toBeInTheDocument();
    });

    test('renders expanded state when context says so', () => {
        mockUseLayout.mockReturnValue({
            isInstructionWidgetExpanded: true,
            setInstructionWidgetExpanded: navFunctions.setInstructionWidgetExpanded
        });

        render(<InstructionWidget />);
        expect(screen.getByTestId('instruction-widget-expanded')).toBeInTheDocument();
        expect(screen.getByTestId('system-prompt-editor')).toBeInTheDocument();
        expect(screen.getByTestId('instruction-looks-good-button')).toBeInTheDocument();
        expect(screen.getByTestId('save-instruction-button')).toBeInTheDocument();
    });

    test('expands when edit button clicked (collapsed mode)', () => {
        render(<InstructionWidget />);
        fireEvent.click(screen.getByTestId('instruction-edit-button'));
        expect(navFunctions.setInstructionWidgetExpanded).toHaveBeenCalledWith(true);
    });

    test('collapses when "Looks good" clicked (expanded mode)', () => {
        mockUseLayout.mockReturnValue({
            isInstructionWidgetExpanded: true,
            setInstructionWidgetExpanded: navFunctions.setInstructionWidgetExpanded
        });
        render(<InstructionWidget />);
        fireEvent.click(screen.getByTestId('instruction-looks-good-button'));
        expect(navFunctions.setInstructionWidgetExpanded).toHaveBeenCalledWith(false);
    });

    test('selects instruction and updates prompt', () => {
        render(<InstructionWidget />);
        const selector = screen.getByTestId('instruction-selector-collapsed');

        // Simulate selection change
        fireEvent.change(selector, { target: { value: 'inst-1' } });

        expect(navFunctions.setSelectedInstructionId).toHaveBeenCalledWith('inst-1');
        expect(navFunctions.setSystemPrompt).toHaveBeenCalledWith('System Prompt 1 v2'); // Should pick latest V2
    });

    test('saves new instruction', async () => {
        mockUseLayout.mockReturnValue({
            isInstructionWidgetExpanded: true,
            setInstructionWidgetExpanded: navFunctions.setInstructionWidgetExpanded
        });
        mockUseAI.mockReturnValue({ // Has prompt
            systemPrompt: 'New System Prompt',
            setSystemPrompt: navFunctions.setSystemPrompt,
            selectedInstructionId: null,
            setSelectedInstructionId: navFunctions.setSelectedInstructionId
        });
        mockCreateInstruction.mockResolvedValue({
            id: 'new-id',
            name: 'New Instruction',
            version: 1
        });

        render(<InstructionWidget />);

        // Wait for save button to be enabled (it depends on prompt presence)
        const saveBtn = screen.getByTestId('save-instruction-button');
        expect(saveBtn).not.toBeDisabled();

        fireEvent.click(saveBtn);

        await waitFor(() => {
            expect(mockCreateInstruction).toHaveBeenCalledWith('mock-token', expect.objectContaining({
                instruction: 'New System Prompt'
            }));
            expect(navFunctions.setSelectedInstructionId).toHaveBeenCalledWith('new-id');
            expect(navFunctions.refreshInstructions).toHaveBeenCalled();
            expect(navFunctions.setInstructionWidgetExpanded).toHaveBeenCalledWith(false);
        });
    });

    test('validates renaming interaction', () => {
        mockUseLayout.mockReturnValue({
            isInstructionWidgetExpanded: true,
            setInstructionWidgetExpanded: navFunctions.setInstructionWidgetExpanded
        });
        mockUseAI.mockReturnValue({
            systemPrompt: 'Prompt',
            setSystemPrompt: navFunctions.setSystemPrompt,
            selectedInstructionId: 'inst-1',
            setSelectedInstructionId: navFunctions.setSelectedInstructionId
        });

        render(<InstructionWidget />);

        // Current name should be displayed (found from context logic via prompt matching/useEffect?? or derived from ID)
        // Actually the component derives it from customerInstructions using selectedId
        // Current name should be displayed
        expect(screen.getByTestId('instruction-name-display')).toHaveTextContent('Instruction 1');

        // Click edit name button (it's an icon button title="Rename Instruction")
        const renameBtn = screen.getByTitle('Rename Instruction');
        fireEvent.click(renameBtn);

        // Input should appear
        const input = screen.getByTestId('instruction-name-input');
        expect(input).toBeInTheDocument();
        expect(input).toHaveValue('Instruction 1');

        fireEvent.change(input, { target: { value: 'Renamed Instruction' } });
        expect(input).toHaveValue('Renamed Instruction');
    });
});
