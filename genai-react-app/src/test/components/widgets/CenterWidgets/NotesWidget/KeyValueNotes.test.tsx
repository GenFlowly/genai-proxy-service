import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import KeyValueNotes from '../../../../../components/widgets/CenterWidgets/NotesWidget/KeyValueNotes';

// Mock child components
jest.mock('../../../../../components/widgets/PromptEditorWidget/PromptEditor', () => (props: any) => (
    <textarea
        data-testid={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
    />
));

jest.mock('../../../../../components/common/MultiPurposeButton/MultiPurposeButton', () => (props: any) => (
    <button data-testid="key-value-save-button" onClick={props.onClick}>
        {props.label}
    </button>
));

describe('KeyValueNotes', () => {
    test('renders two editors and save button', () => {
        render(<KeyValueNotes />);
        expect(screen.getByTestId('notes-widget-key-editor')).toBeInTheDocument();
        expect(screen.getByTestId('notes-widget-value-editor')).toBeInTheDocument();
        expect(screen.getByTestId('key-value-save-button')).toBeInTheDocument();
    });

    test('updates keyPrompt state independently', () => {
        render(<KeyValueNotes />);
        const keyEditor = screen.getByTestId('notes-widget-key-editor');

        fireEvent.change(keyEditor, { target: { value: 'My key' } });

        expect(keyEditor).toHaveValue('My key');
    });

    test('updates valuePrompt state independently', () => {
        render(<KeyValueNotes />);
        const valueEditor = screen.getByTestId('notes-widget-value-editor');

        fireEvent.change(valueEditor, { target: { value: 'My value' } });

        expect(valueEditor).toHaveValue('My value');
    });

    test('calls handleSave with both values', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        render(<KeyValueNotes />);

        const keyEditor = screen.getByTestId('notes-widget-key-editor');
        const valueEditor = screen.getByTestId('notes-widget-value-editor');

        fireEvent.change(keyEditor, { target: { value: 'test-key' } });
        fireEvent.change(valueEditor, { target: { value: 'test-value' } });

        const saveBtn = screen.getByTestId('key-value-save-button');
        fireEvent.click(saveBtn);

        expect(consoleSpy).toHaveBeenCalledWith('Save clicked', {
            key: 'test-key',
            value: 'test-value',
            mode: 'KEY_VALUE'
        });
        consoleSpy.mockRestore();
    });
});
