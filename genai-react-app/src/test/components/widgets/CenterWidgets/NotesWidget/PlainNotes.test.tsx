import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlainNotes from '../../../../../components/widgets/CenterWidgets/NotesWidget/PlainNotes';

jest.mock('../../../../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token') })
}));

Object.defineProperty(global, 'crypto', {
    value: {
        randomUUID: () => 'mock-uuid',
    },
});

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
    beforeEach(() => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

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

    test('calls handleSave with empty prompt initially', async () => {
        render(<PlainNotes />);

        const saveBtn = screen.getByText('Save');
        fireEvent.click(saveBtn);

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toContain('/api/v1/notes');
        expect(JSON.parse(options.body).data.note_value).toBe('');
    });

    test('saves the note through the notes API with the entered prompt', async () => {
        render(<PlainNotes />);

        const editor = screen.getByTestId('notes-widget-editor');
        fireEvent.change(editor, { target: { value: 'Test content' } });

        const saveBtn = screen.getByText('Save');
        fireEvent.click(saveBtn);

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toContain('/api/v1/notes');
        expect(options.method).toBe('POST');
        expect(options.headers).toEqual(expect.objectContaining({
            Authorization: 'Bearer mock-token',
        }));

        const body = JSON.parse(options.body);
        expect(body.data.note_value).toBe('Test content');
        expect(body.data.note_key).toBe('mock-uuid');

        // Editor clears after a successful save
        await waitFor(() => {
            expect(editor).toHaveValue('');
        });
    });

    test('logs an error when the save request fails', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        render(<PlainNotes />);

        const editor = screen.getByTestId('notes-widget-editor');
        fireEvent.change(editor, { target: { value: 'Doomed note' } });
        fireEvent.click(screen.getByText('Save'));

        await waitFor(() => {
            expect(errorSpy).toHaveBeenCalledWith('Failed to save plain note:', expect.any(Error));
        });

        // Prompt is kept so the user can retry
        expect(editor).toHaveValue('Doomed note');

        errorSpy.mockRestore();
    });
});
