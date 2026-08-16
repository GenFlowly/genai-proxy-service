import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PlainNotes from '../../../../../components/widgets/CenterWidgets/NotesWidget/PlainNotes';
import { NotesProvider, useNotes } from '../../../../../context/NotesContext';
import { saveNote } from '../../../../../services/saveNotesService';

jest.mock('../../../../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token') })
}));
jest.mock('../../../../../services/saveNotesService', () => ({
    saveNote: jest.fn().mockResolvedValue({ title: null })
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
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    const typeAndSettle = async (editor: HTMLElement, value: string, ms = 1500) => {
        fireEvent.change(editor, { target: { value } });
        await act(async () => {
            jest.advanceTimersByTime(ms);
        });
    };

    test('renders the editor without a save button', () => {
        render(<PlainNotes />);
        expect(screen.getByTestId('notes-widget-editor')).toBeInTheDocument();
        expect(screen.queryByText('Save')).not.toBeInTheDocument();
    });

    test('initializes with empty prompt and does not autosave it', async () => {
        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor') as HTMLTextAreaElement;
        expect(editor.value).toBe('');

        await act(async () => {
            jest.advanceTimersByTime(20000);
        });
        expect(saveNote).not.toHaveBeenCalled();
    });

    test('autosaves after typing stops, without encoding', async () => {
        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor');

        await typeAndSettle(editor, 'My note content');

        expect(saveNote).toHaveBeenCalledTimes(1);
        expect(saveNote).toHaveBeenCalledWith(
            expect.objectContaining({
                noteKey: 'mock-uuid',
                noteValue: 'My note content',
                client: 'REACT_APP',
            }),
            'mock-token',
            { encode: false, keepalive: false }
        );
        // Content stays in the editor after saving
        expect(editor).toHaveValue('My note content');
    });

    test('reuses the same noteKey across autosaves instead of duplicating notes', async () => {
        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor');

        await typeAndSettle(editor, 'first');
        await typeAndSettle(editor, 'first second');

        expect(saveNote).toHaveBeenCalledTimes(2);
        const keys = (saveNote as jest.Mock).mock.calls.map(([note]) => note.noteKey);
        expect(keys).toEqual(['mock-uuid', 'mock-uuid']);
    });

    test('saves with encoding once typing goes idle', async () => {
        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor');

        await typeAndSettle(editor, 'My note content', 10000);

        const options = (saveNote as jest.Mock).mock.calls.map(([, , opts]) => opts);
        expect(options[0]).toEqual({ encode: false, keepalive: false });
        expect(options[options.length - 1]).toEqual({ encode: true, keepalive: false });
    });

    test('flushes with encoding on blur', async () => {
        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor');

        fireEvent.change(editor, { target: { value: 'My note content' } });
        await act(async () => {
            fireEvent.blur(editor);
        });

        expect(saveNote).toHaveBeenCalledTimes(1);
        expect(saveNote).toHaveBeenCalledWith(
            expect.objectContaining({ noteValue: 'My note content' }),
            'mock-token',
            { encode: true, keepalive: false }
        );
    });

    test('adopts a server-generated title and sends it on later saves', async () => {
        (saveNote as jest.Mock)
            .mockResolvedValueOnce({ title: 'Generated Title' })
            .mockResolvedValue({ title: null });

        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor');

        await typeAndSettle(editor, 'Some note content');
        expect((saveNote as jest.Mock).mock.calls[0][0].title).toBeUndefined();

        await typeAndSettle(editor, 'Some note content, extended');
        expect((saveNote as jest.Mock).mock.calls[1][0].title).toBe('Generated Title');
    });

    test('clears the editor when the active note is cleared (e.g. archived)', async () => {
        function NotesControls() {
            const { openNote, clearActiveNote } = useNotes();
            return (
                <>
                    <button
                        data-testid="open-note"
                        onClick={() => openNote({
                            noteKey: 'k1',
                            noteValue: 'saved content',
                            title: 'Saved title',
                            createdAt: '2026-08-01T10:00:00Z',
                            updatedAt: '2026-08-01T10:00:00Z',
                        })}
                    />
                    <button data-testid="clear-note" onClick={clearActiveNote} />
                </>
            );
        }

        render(
            <NotesProvider>
                <PlainNotes />
                <NotesControls />
            </NotesProvider>
        );
        const editor = screen.getByTestId('notes-widget-editor');

        await act(async () => {
            fireEvent.click(screen.getByTestId('open-note'));
        });
        expect(editor).toHaveValue('saved content');

        // Edit the note, then clear it (archive) before the autosave fires
        fireEvent.change(editor, { target: { value: 'saved content, edited' } });
        await act(async () => {
            fireEvent.click(screen.getByTestId('clear-note'));
        });

        expect(editor).toHaveValue('');

        // Pending edits of the cleared note are dropped — saving them would
        // resurrect an archived note
        await act(async () => {
            jest.advanceTimersByTime(20000);
        });
        expect(saveNote).not.toHaveBeenCalled();
    });

    test('starts a fresh note on New Note, saving pending edits first', async () => {
        function NewNoteControl() {
            const { startNewNote } = useNotes();
            return <button data-testid="start-new-note" onClick={startNewNote} />;
        }

        render(
            <NotesProvider>
                <PlainNotes />
                <NewNoteControl />
            </NotesProvider>
        );
        const editor = screen.getByTestId('notes-widget-editor');

        // Type a draft, then request a new note before the autosave fires
        fireEvent.change(editor, { target: { value: 'my draft' } });
        await act(async () => {
            fireEvent.click(screen.getByTestId('start-new-note'));
        });

        // Unlike archiving, the draft is flushed (saved), not dropped
        expect(saveNote).toHaveBeenCalledTimes(1);
        expect(saveNote).toHaveBeenCalledWith(
            expect.objectContaining({ noteValue: 'my draft' }),
            'mock-token',
            { encode: true, keepalive: false }
        );
        expect(editor).toHaveValue('');
    });

    test('keeps the content in the editor when a save fails', async () => {
        (saveNote as jest.Mock).mockRejectedValueOnce(new Error('boom'));

        render(<PlainNotes />);
        const editor = screen.getByTestId('notes-widget-editor');

        await typeAndSettle(editor, 'Doomed note');

        expect(saveNote).toHaveBeenCalledTimes(1);
        expect(editor).toHaveValue('Doomed note');

        // The failed save is retried
        await act(async () => {
            jest.advanceTimersByTime(5000);
        });
        expect(saveNote).toHaveBeenCalledTimes(2);
    });
});
