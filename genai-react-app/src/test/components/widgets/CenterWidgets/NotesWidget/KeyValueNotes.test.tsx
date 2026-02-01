import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import KeyValueNotes from '../../../../../components/widgets/CenterWidgets/NotesWidget/KeyValueNotes';

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

    test('calls handleSave with empty values initially', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        render(<KeyValueNotes />);

        const saveBtn = screen.getByText('Save');
        fireEvent.click(saveBtn);

        expect(consoleSpy).toHaveBeenCalledWith('Save clicked', {
            key: '',
            value: '',
            mode: 'KEY_VALUE'
        });
        consoleSpy.mockRestore();
    });

    test('calls handleSave with updated values', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        render(<KeyValueNotes />);

        const keyEditor = screen.getByTestId('notes-widget-key-editor');
        const valueEditor = screen.getByTestId('notes-widget-value-editor');

        fireEvent.change(keyEditor, { target: { value: 'test-key' } });
        fireEvent.change(valueEditor, { target: { value: 'test-value' } });

        const saveBtn = screen.getByText('Save');
        fireEvent.click(saveBtn);

        expect(consoleSpy).toHaveBeenCalledWith('Save clicked', {
            key: 'test-key',
            value: 'test-value',
            mode: 'KEY_VALUE'
        });
        consoleSpy.mockRestore();
    });
});
