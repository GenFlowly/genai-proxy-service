import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateAgentPanel from '../../pages/AgentsPage/CreateAgentPanel/CreateAgentPanel';
import '@testing-library/jest-dom';

jest.mock('../../components/common/VendorModelSelect/VendorModelSelect', () => ({ vendor, model, onChange }: any) => (
    <div data-testid="vendor-model-select">
        <button data-testid="mock-select-claude" type="button" onClick={() => onChange('CLAUDE', 'claude-3-5-sonnet')}>Select Claude</button>
        <span data-testid="selected-vendor-model">{String(vendor)}:{model}</span>
    </div>
));

describe('CreateAgentPanel Component', () => {
    const mockOnBack = jest.fn();
    const mockOnSave = jest.fn();
    const mockOnDeploy = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders all 4 steps and initial form values', () => {
        render(<CreateAgentPanel onBack={mockOnBack} onSave={mockOnSave} onDeploy={mockOnDeploy} />);

        expect(screen.getByText('CREATE NEW AGENT')).toBeInTheDocument();
        expect(screen.getByText('BASICS')).toBeInTheDocument();
        expect(screen.getByText('MODEL & PERSONALITY')).toBeInTheDocument();
        expect(screen.getByText('TOOLS & CAPABILITIES')).toBeInTheDocument();
        expect(screen.getByText('MEMORY')).toBeInTheDocument();

        expect(screen.getByPlaceholderText('e.g. Research Assistant')).toHaveValue('');
        expect(screen.getByPlaceholderText('What does this agent do?')).toHaveValue('');
        expect(screen.getByTestId('selected-vendor-model')).toHaveTextContent('null:');
    });

    test('updates basic fields (name, description, avatar)', async () => {
        render(<CreateAgentPanel onBack={mockOnBack} onSave={mockOnSave} onDeploy={mockOnDeploy} />);

        const nameInput = screen.getByPlaceholderText('e.g. Research Assistant');
        await userEvent.type(nameInput, 'My Agent');
        expect(nameInput).toHaveValue('My Agent');

        const descInput = screen.getByPlaceholderText('What does this agent do?');
        await userEvent.type(descInput, 'Helper bot');
        expect(descInput).toHaveValue('Helper bot');

        const avatarBtn = screen.getByLabelText('Select avatar 🚀');
        await userEvent.click(avatarBtn);
        expect(avatarBtn).toHaveClass(/avatarSelected/);
    });

    test('updates vendor and model when VendorModelSelect triggers onChange', async () => {
        render(<CreateAgentPanel onBack={mockOnBack} onSave={mockOnSave} onDeploy={mockOnDeploy} />);

        await userEvent.click(screen.getByTestId('mock-select-claude'));
        expect(screen.getByTestId('selected-vendor-model')).toHaveTextContent('CLAUDE:claude-3-5-sonnet');
    });

    test('updates temperature slider and system prompt textarea', async () => {
        render(<CreateAgentPanel onBack={mockOnBack} onSave={mockOnSave} onDeploy={mockOnDeploy} />);

        const slider = screen.getByRole('slider');
        fireEvent.change(slider, { target: { value: '0.9' } });
        expect(slider).toHaveValue('0.9');


        const textarea = screen.getByPlaceholderText('You are a helpful assistant that...');
        await userEvent.type(textarea, 'Be polite and concise.');
        expect(textarea).toHaveValue('Be polite and concise.');
    });

    test('toggles tool checkboxes correctly', async () => {
        render(<CreateAgentPanel onBack={mockOnBack} onSave={mockOnSave} onDeploy={mockOnDeploy} />);

        // web_search is checked by default in INITIAL_FORM
        const webSearchCheckbox = screen.getByRole('checkbox', { name: 'Web Search' });
        expect(webSearchCheckbox).toBeChecked();

        await userEvent.click(webSearchCheckbox);
        expect(webSearchCheckbox).not.toBeChecked();

        // email is unchecked by default
        const emailCheckbox = screen.getByRole('checkbox', { name: 'Email' });
        expect(emailCheckbox).not.toBeChecked();

        await userEvent.click(emailCheckbox);
        expect(emailCheckbox).toBeChecked();
    });

    test('changes memory type and context window', async () => {
        render(<CreateAgentPanel onBack={mockOnBack} onSave={mockOnSave} onDeploy={mockOnDeploy} />);

        const longTermRadio = screen.getByRole('radio', { name: 'Long-term' });
        await userEvent.click(longTermRadio);
        expect(longTermRadio).toBeChecked();

        const select = screen.getByRole('combobox');
        await userEvent.selectOptions(select, '16000');
        expect(select).toHaveValue('16000');
    });

    test('calls onBack when back button is clicked', async () => {
        render(<CreateAgentPanel onBack={mockOnBack} />);

        await userEvent.click(screen.getByText('← Back'));
        expect(mockOnBack).toHaveBeenCalledTimes(1);
    });

    test('calls onSave with form data when save button is clicked', async () => {
        render(<CreateAgentPanel onBack={mockOnBack} onSave={mockOnSave} />);

        await userEvent.type(screen.getByPlaceholderText('e.g. Research Assistant'), 'Test Save Agent');
        await userEvent.click(screen.getByText('Save'));

        expect(mockOnSave).toHaveBeenCalledTimes(1);
        expect(mockOnSave).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Test Save Agent',
            avatar: '🤖'
        }));
    });

    test('calls onDeploy with form data when deploy button is clicked', async () => {
        render(<CreateAgentPanel onBack={mockOnBack} onDeploy={mockOnDeploy} />);

        await userEvent.type(screen.getByPlaceholderText('e.g. Research Assistant'), 'Test Deploy Agent');
        await userEvent.click(screen.getByText('Deploy'));

        expect(mockOnDeploy).toHaveBeenCalledTimes(1);
        expect(mockOnDeploy).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Test Deploy Agent'
        }));
    });
});
