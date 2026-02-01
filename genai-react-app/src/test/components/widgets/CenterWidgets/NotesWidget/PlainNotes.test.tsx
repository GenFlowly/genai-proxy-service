import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import PlainNotes from '../../../../../components/widgets/CenterWidgets/NotesWidget/PlainNotes';

// Mock child components
jest.mock('../../../../../components/widgets/PromptEditorWidget/PromptEditor', () => (props: any) => (
    <textarea
        data-testid="plain-notes-editor"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
    />
));

jest.mock('../../../../../components/common/MultiPurposeButton/MultiPurposeButton', () => (props: any) => (
    <button data-testid="plain-notes-save-button" onClick={props.onClick}>
        {props.label}
    </button>
));

describe('PlainNotes', () => {
    test('renders editor and save button', () => {
        render(<PlainNotes />);
        expect(screen.getByTestId('plain-notes-editor')).toBeInTheDocument();
        expect(screen.getByTestId('plain-notes-save-button')).toBeInTheDocument();
    });

    test('updates prompt state when typing', () => {
        render(<PlainNotes />);
        const editor = screen.getByTestId('plain-notes-editor');

        fireEvent.change(editor, { target: { value: 'My plain note' } });

        expect(editor).toHaveValue('My plain note');
    });

    test('calls handleSave with correct data', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        render(<PlainNotes />);

        const editor = screen.getByTestId('plain-notes-editor');
        fireEvent.change(editor, { target: { value: 'Note to save' } });

        const saveBtn = screen.getByTestId('plain-notes-save-button');
        fireEvent.click(saveBtn);

        expect(consoleSpy).toHaveBeenCalledWith('Save clicked', { prompt: 'Note to save', mode: 'PLAIN' });
        consoleSpy.mockRestore();
    });
});
