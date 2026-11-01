import { saveNote, getNotes, deleteNote } from '../../services/saveNotesService';
import { HttpMethod } from '../../constants/http';
import { NotesModel } from '../../models/encoding.models';
import { config } from '../../config/env';

describe('saveNotesService', () => {
    const mockToken = 'mock-token';
    const mockNote: NotesModel = {
        noteKey: 'key-1',
        noteValue: 'value-1',
        title: 'Title 1',
        createdAt: '2023-01-01',
        client: 'genai-react-app',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
    });

    test('saveNote calls fetch with correct parameters', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
        });

        await saveNote(mockNote, mockToken);

        expect(global.fetch).toHaveBeenCalledWith(
            `${config.backend.baseUrl}/api/v1/notes`,
            expect.objectContaining({
                method: HttpMethod.POST,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${mockToken}`,
                },
                body: JSON.stringify({
                    client: 'genai-react-app',
                    encode: true,
                    data: {
                        note_key: mockNote.noteKey,
                        note_value: mockNote.noteValue,
                        title: mockNote.title,
                        created_at: mockNote.createdAt,
                    },
                }),
                keepalive: false,
            })
        );
    });

    test('saveNote returns the title from the response body', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ status: 'success', title: 'Generated Title' }),
        });

        const result = await saveNote(mockNote, mockToken);

        expect(result).toEqual({ title: 'Generated Title' });
    });

    test('saveNote returns a null title when the response has no body', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await saveNote(mockNote, mockToken);

        expect(result).toEqual({ title: null });
    });

    test('saveNote forwards encode=false and keepalive for autosaves', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
        });

        await saveNote(mockNote, mockToken, { encode: false, keepalive: true });

        const [, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(JSON.parse(options.body).encode).toBe(false);
        expect(options.keepalive).toBe(true);
    });

    test('saveNote throws error when response is not ok', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        });

        await expect(saveNote(mockNote, mockToken)).rejects.toThrow(
            'Failed to save note: 500 Internal Server Error'
        );
    });

    test('getNotes fetches and returns the notes array', async () => {
        const notes = [
            { noteKey: 'k1', noteValue: 'v1', title: 'T1', createdAt: '2026-08-01', updatedAt: '2026-08-01' },
        ];
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ notes }),
        });

        const result = await getNotes(mockToken);

        expect(global.fetch).toHaveBeenCalledWith(
            `${config.backend.baseUrl}/api/v1/notes`,
            expect.objectContaining({
                method: HttpMethod.GET,
                headers: {
                    Authorization: `Bearer ${mockToken}`,
                },
            })
        );
        expect(result).toEqual(notes);
    });

    test('getNotes returns empty array when notes field is missing', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({}),
        });

        const result = await getNotes(mockToken);

        expect(result).toEqual([]);
    });

    test('getNotes throws error when response is not ok', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        });

        await expect(getNotes(mockToken)).rejects.toThrow(
            'Failed to fetch notes: 403 Forbidden'
        );
    });

    test('deleteNote calls fetch with the encoded note key', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        await deleteNote(mockToken, 'key/with special');

        expect(global.fetch).toHaveBeenCalledWith(
            `${config.backend.baseUrl}/api/v1/notes/${encodeURIComponent('key/with special')}`,
            expect.objectContaining({
                method: HttpMethod.DELETE,
                headers: {
                    Authorization: `Bearer ${mockToken}`,
                },
            })
        );
    });

    test('deleteNote throws error when response is not ok', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        });

        await expect(deleteNote(mockToken, 'k1')).rejects.toThrow(
            'Failed to delete note: 404 Not Found'
        );
    });
});

describe('saveNotesService write-through', () => {
    const {
        loadNotesCache,
        saveNotesCache,
        clearNotesCache,
    } = require('../../components/widgets/SidebarWidgets/SavedNotesWidget/notesCache');
    const { saveNote, deleteNote } = require('../../services/saveNotesService');

    beforeEach(() => {
        global.fetch = jest.fn();
        clearNotesCache();
    });

    test('saveNote upserts into an existing notes cache', async () => {
        localStorage.setItem('customerId', 'CU_WT_NOTE');
        saveNotesCache('CU_WT_NOTE', [
            { noteKey: 'k1', noteValue: 'old', title: 'Old', createdAt: 't0', updatedAt: 't0' },
        ]);
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ title: 'New Title' }),
        });

        await saveNote({ noteKey: 'k1', noteValue: 'new', createdAt: 't0', client: 'c' }, 'tok');

        const cached = loadNotesCache('CU_WT_NOTE');
        expect(cached).toHaveLength(1);
        expect(cached[0]).toMatchObject({ noteKey: 'k1', noteValue: 'new', title: 'New Title' });
    });

    test('saveNote does not fabricate a cache when none exists', async () => {
        localStorage.setItem('customerId', 'CU_WT_NOCACHE');
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        await saveNote({ noteKey: 'k9', noteValue: 'v', createdAt: 't0', client: 'c' }, 'tok');

        expect(loadNotesCache('CU_WT_NOCACHE')).toBeNull();
    });

    test('deleteNote removes the note from the cache', async () => {
        localStorage.setItem('customerId', 'CU_WT_DEL');
        saveNotesCache('CU_WT_DEL', [
            { noteKey: 'k1', noteValue: 'a', title: 'A', createdAt: 't0', updatedAt: 't0' },
            { noteKey: 'k2', noteValue: 'b', title: 'B', createdAt: 't0', updatedAt: 't0' },
        ]);
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        await deleteNote('tok', 'k1');

        expect(loadNotesCache('CU_WT_DEL')).toEqual([
            { noteKey: 'k2', noteValue: 'b', title: 'B', createdAt: 't0', updatedAt: 't0' },
        ]);
    });
});
