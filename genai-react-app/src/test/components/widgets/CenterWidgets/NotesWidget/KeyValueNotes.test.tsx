import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import KeyValueNotes from '../../../../../components/widgets/CenterWidgets/NotesWidget/KeyValueNotes';
import { saveNote } from '../../../../../services/saveNotesService';

jest.mock('../../../../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token') })
}));
jest.mock('../../../../../services/saveNotesService', () => ({
    saveNote: jest.fn().mockResolvedValue(undefined)
}));

// Mock PromptEditor to make it testable
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    PromptEditor: function MockPromptEditor(props: any) {
        return (
            <textarea
                data-testid={props.id}
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
            />
        );
    },
}));

describe('KeyValueNotes', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    const settle = async (ms = 1500) => {
        await act(async () => {
            jest.advanceTimersByTime(ms);
        });
    };

    test('renders both editors without a save button', () => {
        render(<KeyValueNotes />);
        expect(screen.getByTestId('notes-widget-key-editor')).toBeInTheDocument();
        expect(screen.getByTestId('notes-widget-value-editor')).toBeInTheDocument();
        expect(screen.queryByText('Save')).not.toBeInTheDocument();
    });

    test('initializes with empty prompts', () => {
        render(<KeyValueNotes />);
        const keyEditor = screen.getByTestId('notes-widget-key-editor') as HTMLTextAreaElement;
        const valueEditor = screen.getByTestId('notes-widget-value-editor') as HTMLTextAreaElement;
        expect(keyEditor.value).toBe('');
        expect(valueEditor.value).toBe('');
    });

    test('does not autosave while the key is empty', async () => {
        render(<KeyValueNotes />);
        const valueEditor = screen.getByTestId('notes-widget-value-editor');

        fireEvent.change(valueEditor, { target: { value: 'My value' } });
        await settle(20000);

        expect(saveNote).not.toHaveBeenCalled();
    });

    test('typing in the key field alone does not trigger a save', async () => {
        render(<KeyValueNotes />);
        const keyEditor = screen.getByTestId('notes-widget-key-editor');

        fireEvent.change(keyEditor, { target: { value: 'my-key' } });
        await settle(20000);

        expect(saveNote).not.toHaveBeenCalled();
    });

    test('autosaves the value under the entered key', async () => {
        render(<KeyValueNotes />);
        const keyEditor = screen.getByTestId('notes-widget-key-editor');
        const valueEditor = screen.getByTestId('notes-widget-value-editor');

        fireEvent.change(keyEditor, { target: { value: 'test-key' } });
        fireEvent.change(valueEditor, { target: { value: 'test-value' } });
        await settle();

        expect(saveNote).toHaveBeenCalledTimes(1);
        expect(saveNote).toHaveBeenCalledWith(
            expect.objectContaining({
                noteKey: 'test-key',
                noteValue: 'test-value',
                client: 'REACT_APP',
            }),
            'mock-token',
            { encode: false, keepalive: false }
        );
    });

    test('flushes with encoding when the value editor blurs', async () => {
        render(<KeyValueNotes />);
        const keyEditor = screen.getByTestId('notes-widget-key-editor');
        const valueEditor = screen.getByTestId('notes-widget-value-editor');

        fireEvent.change(keyEditor, { target: { value: 'test-key' } });
        fireEvent.change(valueEditor, { target: { value: 'test-value' } });
        await act(async () => {
            fireEvent.blur(valueEditor);
        });

        expect(saveNote).toHaveBeenCalledTimes(1);
        expect(saveNote).toHaveBeenCalledWith(
            expect.objectContaining({ noteKey: 'test-key', noteValue: 'test-value' }),
            'mock-token',
            { encode: true, keepalive: false }
        );
    });
});
