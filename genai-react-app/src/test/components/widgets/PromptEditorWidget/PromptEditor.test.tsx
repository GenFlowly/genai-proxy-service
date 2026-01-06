import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import PromptEditor from '../../../../components/widgets/PromptEditorWidget/PromptEditor';
import '@testing-library/jest-dom';

// Mock dependencies
jest.mock('@uiw/react-markdown-editor', () => ({ value, onChange, toolbars, visible, enablePreview, ...props }: any) => {
    return (
        <div data-testid="markdown-editor-mock">
            <textarea
                data-testid="mock-textarea"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                {...props}
            />
            <div data-testid="mock-toolbar">
                {toolbars && toolbars.length > 0 ? 'Has Toolbars' : 'No Toolbars'}
            </div>
        </div>
    );
});

jest.mock('@codemirror/view', () => ({
    EditorView: {
        lineWrapping: 'mock-extension'
    }
}));

jest.mock('../../../../components/common/CopyToClipboard/CopyToClipboard', () => ({ content, label, 'data-testid': testId }: any) => (
    <button data-testid={testId || 'copy-button'} onClick={() => { }}>{label}</button>
));

jest.mock('../../../../components/widgets/PromptEditorWidget/CustomToolbarCommands', () => ({
    addStepsCommand: { name: 'addSteps' },
    addExamplesCommand: { name: 'addExamples' }
}));

describe('PromptEditor Component', () => {
    const defaultProps = {
        id: 'test-editor',
        value: 'Initial Prompt',
        onChange: jest.fn(),
        'data-testid': 'prompt-editor'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders with initial value', () => {
        render(<PromptEditor {...defaultProps} />);

        expect(screen.getByTestId('prompt-editor')).toBeInTheDocument();
        expect(screen.getByTestId('mock-textarea')).toHaveValue('Initial Prompt');
        expect(screen.getByTestId('copy-button')).toBeInTheDocument();
    });

    test('handles typing (Active state)', () => {
        render(<PromptEditor {...defaultProps} />);
        const textarea = screen.getByTestId('mock-textarea');

        fireEvent.change(textarea, { target: { value: 'Updated Prompt' } });
        expect(defaultProps.onChange).toHaveBeenCalledWith('Updated Prompt');
    });

    test('handles focus state', () => {
        render(<PromptEditor {...defaultProps} />);
        const textarea = screen.getByTestId('mock-textarea');

        textarea.focus();
        expect(textarea).toHaveFocus();
    });

    test('renders toolbars', () => {
        render(<PromptEditor {...defaultProps} />);
        expect(screen.getByTestId('mock-toolbar')).toHaveTextContent('Has Toolbars');
    });

    test('handles copy button existence', () => {
        render(<PromptEditor {...defaultProps} />);
        const btn = screen.getByTestId('copy-button');
        expect(btn).toBeInTheDocument();
        expect(btn).toHaveTextContent('Copy Prompt');
    });
});
