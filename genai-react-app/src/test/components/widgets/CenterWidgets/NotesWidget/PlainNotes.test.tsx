import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlainNotes from '../../../../../components/widgets/CenterWidgets/NotesWidget/PlainNotes';

// Mock PromptEditor to make it testable
jest.mock('../../../../../components/widgets/PromptEditorWidget/PromptEditor', () => {
    return function MockPromptEditor(props: any) {
        return (
            <textarea
                data-testid={props.id}
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
            />
        );
    };
});

describe('PlainNotes', () => {
    test('renders editor and save button', () => {
        render(<PlainNotes />);
        expect(screen.getByTestId('notes-widget-editor')).toBeInTheDocument();
        expect(screen.getByText('Save')).toBeInTheDocument();
    });

    test('initializes with empty prompt', () => {
        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor') as HTMLTextAreaElement;
        expect(editor.value).toBe('');
    });

    test('updates prompt state when editor changes', () => {
        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor');

        fireEvent.change(editor, { target: { value: 'My note content' } });

        expect(editor).toHaveValue('My note content');
    });

    test('calls handleSave with empty prompt initially', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        render(<PlainNotes />);

        const saveBtn = screen.getByText('Save');
        fireEvent.click(saveBtn);

        expect(consoleSpy).toHaveBeenCalledWith('Save clicked', { prompt: '', mode: 'PLAIN' });
        consoleSpy.mockRestore();
    });

    test('calls handleSave with updated prompt', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        render(<PlainNotes />);

        const editor = screen.getByTestId('notes-widget-editor');
        fireEvent.change(editor, { target: { value: 'Test content' } });

        const saveBtn = screen.getByText('Save');
        fireEvent.click(saveBtn);

        expect(consoleSpy).toHaveBeenCalledWith('Save clicked', { prompt: 'Test content', mode: 'PLAIN' });
        consoleSpy.mockRestore();
    });
});
