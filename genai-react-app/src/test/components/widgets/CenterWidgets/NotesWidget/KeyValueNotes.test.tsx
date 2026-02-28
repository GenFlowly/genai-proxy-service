import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import KeyValueNotes from '../../../../../components/widgets/CenterWidgets/NotesWidget/KeyValueNotes';
import { saveNote } from '../../../../../services/saveNotesService';

jest.mock('../../../../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token') })
}));
jest.mock('../../../../../services/saveNotesService', () => ({
    saveNote: jest.fn().mockResolvedValue({})
}));

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

describe('KeyValueNotes', () => {
    test('renders both editors and save button', () => {
        render(<KeyValueNotes />);
        expect(screen.getByTestId('notes-widget-key-editor')).toBeInTheDocument();
        expect(screen.getByTestId('notes-widget-value-editor')).toBeInTheDocument();
        expect(screen.getByText('Save')).toBeInTheDocument();
    });

    test('initializes with empty prompts', () => {
        render(<KeyValueNotes />);
        const keyEditor = screen.getByTestId('notes-widget-key-editor') as HTMLTextAreaElement;
        const valueEditor = screen.getByTestId('notes-widget-value-editor') as HTMLTextAreaElement;
        expect(keyEditor.value).toBe('');
        expect(valueEditor.value).toBe('');
    });

    test('updates keyPrompt state when key editor changes', () => {
        render(<KeyValueNotes />);
        const keyEditor = screen.getByTestId('notes-widget-key-editor');

        fireEvent.change(keyEditor, { target: { value: 'My key' } });

        expect(keyEditor).toHaveValue('My key');
    });

    test('updates valuePrompt state when value editor changes', () => {
        render(<KeyValueNotes />);
        const valueEditor = screen.getByTestId('notes-widget-value-editor');

        fireEvent.change(valueEditor, { target: { value: 'My value' } });

        expect(valueEditor).toHaveValue('My value');
    });

    test('calls handleSave with empty values initially', async () => {
        render(<KeyValueNotes />);

        const saveBtn = screen.getByText('Save');
        fireEvent.click(saveBtn);

        await waitFor(() => {
            expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({
                noteKey: '',
                noteValue: '',
                client: 'REACT_APP'
            }), 'mock-token');
        });
    });

    test('calls handleSave with updated values', async () => {
        render(<KeyValueNotes />);

        const keyEditor = screen.getByTestId('notes-widget-key-editor');
        const valueEditor = screen.getByTestId('notes-widget-value-editor');

        fireEvent.change(keyEditor, { target: { value: 'test-key' } });
        fireEvent.change(valueEditor, { target: { value: 'test-value' } });

        const saveBtn = screen.getByText('Save');
        fireEvent.click(saveBtn);

        await waitFor(() => {
            expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({
                noteKey: 'test-key',
                noteValue: 'test-value',
                client: 'REACT_APP'
            }), 'mock-token');
        });
    });
});
