import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import NotesWidget from '../../../../../components/widgets/CenterWidgets/NotesWidget/NotesWidget';

// Mock child components
jest.mock('../../../../../components/widgets/PromptEditorWidget/PromptEditor', () => (props: any) => (
    <textarea
        data-testid="mock-prompt-editor"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
    />
));

jest.mock('../../../../../components/common/MultiPurposeButton/MultiPurposeButton', () => (props: any) => (
    <button data-testid="save-button" onClick={props.onClick}>
        {props.label}
    </button>
));

describe('NotesWidget', () => {
    test('renders correctly', () => {
        render(<NotesWidget />);
        expect(screen.getByTestId('mock-prompt-editor')).toBeInTheDocument();
        expect(screen.getByTestId('save-button')).toBeInTheDocument();
    });

    test('updates content when typing', () => {
        render(<NotesWidget />);
        const editor = screen.getByTestId('mock-prompt-editor');

        fireEvent.change(editor, { target: { value: 'New Note Content' } });

        expect(editor).toHaveValue('New Note Content');
    });

    test('handles save click', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        render(<NotesWidget />);

        const editor = screen.getByTestId('mock-prompt-editor');
        fireEvent.change(editor, { target: { value: 'Note to save' } });

        const saveBtn = screen.getByTestId('save-button');
        fireEvent.click(saveBtn);

        expect(consoleSpy).toHaveBeenCalledWith('Save clicked', { prompt: 'Note to save' });
        consoleSpy.mockRestore();
    });
});
